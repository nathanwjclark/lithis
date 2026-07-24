import {
  artifactSchema,
  newUlid,
  nowIso,
  slugSchema,
  templateSchema,
} from "@lithis/core";
import type {
  Artifact,
  Evidence,
  EvidenceSource,
  Origin,
  PrincipalContext,
  Template,
  Ulid,
} from "@lithis/core";
import { z } from "zod";
import { insertEvidence, sha256Hex } from "../agents";
import type { CompleteFn } from "../agents";
import type { ContextStore } from "../context";
import { txSql } from "../db";
import type { Db } from "../db";
import type { HumanGate } from "../humangate";
import type { EventSpine } from "../spine";
import {
  DETERMINISTIC_CHECKS,
  parseCheckRef,
  runDeterministicCheck,
  runRubricCheck,
} from "./checks";
import type { CheckOutcome } from "./checks";
import { assertSupportedFieldsSchema, validateInputs } from "./fields";
import { collectRootFields, renderTemplate } from "./render";
import type {
  ArtifactEngine,
  ArtifactTemplateRef,
  TemplateDraft,
  TemplateProposal,
  VerificationReport,
} from "./index";
import { renderVisualArtifact } from "./index";

/**
 * The Postgres ArtifactEngine.
 *
 * Templates follow the skills-registry shape: a version row is written, and
 * when `approvalPolicy: 'always'` it is UNUSABLE until its
 * HumanRequest{template_change} is approved — render() re-checks the gate on
 * every call rather than trusting a cached flag.
 *
 * render() is deterministic end to end: inputs are validated against the
 * template's fieldsSchema, the body blob is filled by the strict renderer
 * (render.ts — an unfilled or unknown placeholder is an error, never a blank),
 * the output is persisted as a content-addressed blob, and the draft artifact
 * comes back with an Evidence record naming exactly what produced it.
 *
 * verify() runs the template's checks and writes the result as Evidence of
 * kind 'verification' — verification IS Evidence. Unknown deterministic refs
 * and un-runnable rubrics FAIL with explicit findings; nothing about this path
 * can silently pass.
 */

export class TemplateNotFoundError extends Error {
  constructor(id: string) {
    super(`template ${id} not found`);
    this.name = "TemplateNotFoundError";
  }
}

export class TemplateNotApprovedError extends Error {
  constructor(slug: string, version: string, state: string) {
    super(
      `template '${slug}' v${version} cannot render: its approvalPolicy is 'always' and the ` +
        `template_change request is '${state}', not 'approved'`,
    );
    this.name = "TemplateNotApprovedError";
  }
}

export class ArtifactNotFoundError extends Error {
  constructor(id: string) {
    super(`artifact ${id} not found`);
    this.name = "ArtifactNotFoundError";
  }
}

/** The pinned payload for HumanRequest{subjectKind:'template_change'} (artifacts). */
export const templateChangePayloadSchema = z.object({
  slug: slugSchema,
  version: z.string().min(1),
  kind: z.string().min(1),
  /** sha256 of the template body blob — what the approver is actually approving. */
  bodyChecksum: z.string().min(1),
  priorVersion: z.string().optional(),
  fieldsAdded: z.array(z.string()),
  fieldsRemoved: z.array(z.string()),
  checksAdded: z.array(z.string()),
  checksRemoved: z.array(z.string()),
  /** Deterministic check refs this build cannot resolve — an approver MUST see these. */
  unknownCheckRefs: z.array(z.string()),
});
export type TemplateChangePayload = z.infer<typeof templateChangePayloadSchema>;

/** Media types per template kind — document/report are markdown, email is plain text. */
const OUTPUT_MEDIA_TYPE: Record<Template["kind"], string> = {
  document: "text/markdown",
  report: "text/markdown",
  email: "text/plain",
  image: "application/octet-stream",
  video: "application/octet-stream",
};

function fromJsonb(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

interface TemplateRow {
  id: string;
  tenant_id: string;
  slug: string;
  version: string;
  kind: string;
  fields_schema: unknown;
  body_blob_id: string;
  checks: unknown;
  approval_policy: string;
  approval_request_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ArtifactRow {
  id: string;
  tenant_id: string;
  template_ref: unknown;
  inputs_json: unknown;
  output_blob_id: string;
  verification: unknown;
  state: string;
  produced_by_run_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export function rowToTemplate(row: TemplateRow): Template {
  return templateSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    slug: row.slug,
    version: row.version,
    kind: row.kind,
    fieldsSchema: fromJsonb(row.fields_schema),
    bodyBlobId: row.body_blob_id,
    checks: fromJsonb(row.checks),
    approvalPolicy: row.approval_policy,
    ...(row.approval_request_id !== null ? { approvalRequestId: row.approval_request_id } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

export function rowToArtifact(row: ArtifactRow): Artifact {
  return artifactSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    templateRef: fromJsonb(row.template_ref),
    inputsJson: fromJsonb(row.inputs_json),
    outputBlobId: row.output_blob_id,
    ...(row.verification !== null ? { verification: fromJsonb(row.verification) } : {}),
    state: row.state,
    ...(row.produced_by_run_id !== null ? { producedByRunId: row.produced_by_run_id } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

/** Field names a fieldsSchema declares at the root. */
function declaredFields(fieldsSchema: Record<string, unknown>): string[] {
  const props = fieldsSchema["properties"];
  return typeof props === "object" && props !== null && !Array.isArray(props)
    ? Object.keys(props).sort()
    : [];
}

function checkLabel(check: Template["checks"][number]): string {
  return check.kind === "deterministic" ? `deterministic:${check.ref}` : `rubric:${check.prompt}`;
}

export interface ArtifactEngineDeps {
  db: Db;
  spine: EventSpine;
  humanGate: HumanGate;
  contextStore: ContextStore;
  /** Injectable LLM seam for rubric checks; absent → rubrics are skipped (and cannot pass). */
  complete?: CompleteFn;
  model: string;
}

export function createPgArtifactEngine(deps: ArtifactEngineDeps): ArtifactEngine {
  const { db, spine, humanGate, contextStore } = deps;

  async function loadTemplate(id: Ulid, tenantId: Ulid): Promise<Template> {
    const rows: TemplateRow[] = await db.sql`
      select * from artifacts.templates where id = ${id} and tenant_id = ${tenantId}`;
    const row = rows[0];
    if (row === undefined) throw new TemplateNotFoundError(id);
    return rowToTemplate(row);
  }

  async function loadArtifact(id: Ulid, tenantId: Ulid): Promise<Artifact> {
    const rows: ArtifactRow[] = await db.sql`
      select * from artifacts.artifacts where id = ${id} and tenant_id = ${tenantId}`;
    const row = rows[0];
    if (row === undefined) throw new ArtifactNotFoundError(id);
    return rowToArtifact(row);
  }

  /** Gate re-check on every render — an approved-then-superseded template stops rendering. */
  async function assertApproved(template: Template): Promise<void> {
    if (template.approvalPolicy !== "always") return;
    if (template.approvalRequestId === undefined) {
      throw new TemplateNotApprovedError(template.slug, template.version, "missing");
    }
    const request = await humanGate.get(template.approvalRequestId, template.tenantId);
    if (request === undefined || request.state !== "approved") {
      throw new TemplateNotApprovedError(template.slug, template.version, request?.state ?? "missing");
    }
  }

  function originFor(p: PrincipalContext): Origin {
    return {
      by: { kind: "principal", id: p.principalId },
      method: "code",
      trust: "internal",
      at: nowIso(),
    };
  }

  return {
    async createTemplate(draft: TemplateDraft, p: PrincipalContext): Promise<TemplateProposal> {
      const slug = slugSchema.parse(draft.slug);
      // Reject a schema this build cannot fully enforce BEFORE anything is
      // persisted — a template whose inputs cannot be validated must not exist.
      assertSupportedFieldsSchema(draft.fieldsSchema);

      const bodyBytes = await contextStore.readBlob(draft.tenantId, draft.bodyBlobId);
      const body = new TextDecoder().decode(bodyBytes);
      const bodyChecksum = sha256Hex(body);
      // Parses the body (throws TemplateRenderError on bad syntax) and reports
      // the root fields it references.
      const referenced = collectRootFields(body);
      const declared = declaredFields(draft.fieldsSchema);
      const undeclared = referenced.filter((f) => !declared.includes(f));
      if (undeclared.length > 0) {
        throw new Error(
          `template '${slug}' v${draft.version} references field(s) its fieldsSchema does not declare: ` +
            `${undeclared.join(", ")} (declared: ${declared.length === 0 ? "none" : declared.join(", ")})`,
        );
      }

      const checks = draft.checks ?? [];
      // Surfaced on the approval card: a check ref this build cannot resolve
      // would fail every verification, so the approver must see it up front.
      const unknownCheckRefs = checks
        .filter((c): c is { kind: "deterministic"; ref: string } => c.kind === "deterministic")
        .map((c) => c.ref)
        .filter((ref) => DETERMINISTIC_CHECKS[parseCheckRef(ref).name] === undefined);

      const priorRows: TemplateRow[] = await db.sql`
        select * from artifacts.templates
        where tenant_id = ${draft.tenantId} and slug = ${slug}
        order by created_at desc limit 1`;
      const prior = priorRows[0] === undefined ? undefined : rowToTemplate(priorRows[0]);
      if (prior !== undefined && prior.version === draft.version) {
        throw new Error(
          `template '${slug}' v${draft.version} already exists — template bodies are immutable; publish a new version`,
        );
      }

      const priorFields = prior === undefined ? [] : declaredFields(prior.fieldsSchema);
      const priorChecks = prior === undefined ? [] : prior.checks.map(checkLabel);
      const nextChecks = checks.map(checkLabel);
      const approvalPolicy = draft.approvalPolicy ?? "always";

      const at = nowIso();
      const id = newUlid();
      const template = templateSchema.parse({
        id,
        tenantId: draft.tenantId,
        slug,
        version: draft.version,
        kind: draft.kind,
        fieldsSchema: draft.fieldsSchema,
        bodyBlobId: draft.bodyBlobId,
        checks,
        approvalPolicy,
        createdAt: at,
        updatedAt: at,
      });

      await db.withTx(async (tx) => {
        await txSql(tx)`
          insert into artifacts.templates
            (id, tenant_id, slug, version, kind, fields_schema, body_blob_id, checks,
             approval_policy, approval_request_id, created_at, updated_at)
          values
            (${template.id}, ${template.tenantId}, ${template.slug}, ${template.version},
             ${template.kind}, ${JSON.stringify(template.fieldsSchema)}::text::jsonb,
             ${template.bodyBlobId}, ${JSON.stringify(template.checks)}::text::jsonb,
             ${template.approvalPolicy}, null, ${at}, ${at})`;
        await spine.append(tx, {
          tenantId: template.tenantId,
          topic: "artifact.template.created",
          subjectRefs: [{ kind: "template", id: template.id }],
          actor: { kind: "principal", id: p.principalId },
          payload: {
            slug: template.slug,
            version: template.version,
            kind: template.kind,
            bodyChecksum,
          },
        });
      });

      if (approvalPolicy !== "always") {
        return { template };
      }

      const payload: TemplateChangePayload = templateChangePayloadSchema.parse({
        slug: template.slug,
        version: template.version,
        kind: template.kind,
        bodyChecksum,
        ...(prior !== undefined ? { priorVersion: prior.version } : {}),
        fieldsAdded: declared.filter((f) => !priorFields.includes(f)),
        fieldsRemoved: priorFields.filter((f) => !declared.includes(f)),
        checksAdded: nextChecks.filter((c) => !priorChecks.includes(c)),
        checksRemoved: priorChecks.filter((c) => !nextChecks.includes(c)),
        unknownCheckRefs,
      });
      const request = await humanGate.request({
        tenantId: template.tenantId,
        kind: "approval",
        subjectKind: "template_change",
        subjectRef: { kind: "template", id: template.id },
        payload,
        evidenceIds: [],
        summary:
          `Approve template '${template.slug}' v${template.version} (${template.kind})` +
          `${prior === undefined ? " — new template" : ` — replaces v${prior.version}`}? ` +
          `Fields +[${payload.fieldsAdded.join(", ")}] -[${payload.fieldsRemoved.join(", ")}]; ` +
          `checks +[${payload.checksAdded.join(", ")}] -[${payload.checksRemoved.join(", ")}]; ` +
          `body sha256 ${bodyChecksum.slice(0, 12)}…` +
          (payload.unknownCheckRefs.length > 0
            ? ` — WARNING: unresolvable check ref(s) ${payload.unknownCheckRefs.join(", ")} will always FAIL verification.`
            : ""),
        options: ["approve", "deny"],
        routing: {
          assignee: "tenant-admin",
          channelPrefs: ["portal"],
          escalationPath: [],
          followUpCount: 0,
        },
        requestedBy: { kind: "principal", id: p.principalId },
      });

      await db.withTx(async (tx) => {
        await txSql(tx)`
          update artifacts.templates
          set approval_request_id = ${request.id}, updated_at = ${nowIso()}
          where id = ${template.id}`;
        await spine.append(tx, {
          tenantId: template.tenantId,
          topic: "artifact.template.change_proposed",
          subjectRefs: [
            { kind: "template", id: template.id },
            { kind: "human_request", id: request.id },
          ],
          actor: { kind: "principal", id: p.principalId },
          payload: {
            slug: template.slug,
            version: template.version,
            ...(prior !== undefined ? { priorVersion: prior.version } : {}),
            humanRequestId: request.id,
          },
        });
      });

      return {
        template: { ...template, approvalRequestId: request.id },
        approvalRequestId: request.id,
      };
    },

    async listTemplates(tenantId: Ulid): Promise<Template[]> {
      const rows: TemplateRow[] = await db.sql`
        select * from artifacts.templates where tenant_id = ${tenantId}
        order by slug, version`;
      return rows.map(rowToTemplate);
    },

    async getTemplate(id: Ulid, tenantId: Ulid): Promise<Template | undefined> {
      const rows: TemplateRow[] = await db.sql`
        select * from artifacts.templates where id = ${id} and tenant_id = ${tenantId}`;
      return rows[0] === undefined ? undefined : rowToTemplate(rows[0]);
    },

    async getArtifact(id: Ulid, tenantId: Ulid): Promise<Artifact | undefined> {
      const rows: ArtifactRow[] = await db.sql`
        select * from artifacts.artifacts where id = ${id} and tenant_id = ${tenantId}`;
      return rows[0] === undefined ? undefined : rowToArtifact(rows[0]);
    },

    async render(
      t: ArtifactTemplateRef,
      inputs: unknown,
      p: PrincipalContext,
    ): Promise<{ artifact: Artifact; evidence: Evidence }> {
      const template = await loadTemplate(t.id, p.tenantId);
      if (template.version !== t.version) {
        throw new TemplateNotFoundError(
          `${t.id}@${t.version} (that id is version ${template.version})`,
        );
      }
      await assertApproved(template);

      if (template.kind === "image" || template.kind === "video") {
        // Loud, registered, and actually reached — no silent text fallback for
        // a kind this engine has no honest way to produce.
        await renderVisualArtifact(t, inputs, p);
      }

      const validated = validateInputs(template.fieldsSchema, inputs);
      const body = new TextDecoder().decode(
        await contextStore.readBlob(template.tenantId, template.bodyBlobId),
      );
      const { output, usedFields } = renderTemplate(body, validated);

      const origin = originFor(p);
      const outputRef = await contextStore.putBlob(
        {
          tenantId: p.tenantId,
          mediaType: OUTPUT_MEDIA_TYPE[template.kind],
          origin,
        },
        new TextEncoder().encode(output),
      );

      const artifactId = newUlid();
      const at = nowIso();
      const artifact = artifactSchema.parse({
        id: artifactId,
        tenantId: p.tenantId,
        templateRef: { id: template.id, version: template.version },
        inputsJson: validated,
        outputBlobId: outputRef.id,
        state: "draft",
        createdAt: at,
        updatedAt: at,
      });

      const sources: EvidenceSource[] = [
        {
          ref: { kind: "template", id: template.id },
          locator: `${template.slug}@${template.version}`,
          whyRelevant: `The template body (blob ${template.bodyBlobId}) this artifact was filled from.`,
        },
        {
          ref: { kind: "blob", id: template.bodyBlobId },
          whyRelevant: `Template body bytes, sha256 ${sha256Hex(body)}.`,
        },
        {
          ref: { kind: "blob", id: outputRef.id },
          whyRelevant: `The rendered output, sha256 ${sha256Hex(output)}.`,
        },
      ];

      const evidence = await db.withTx(async (tx) => {
        await txSql(tx)`
          insert into artifacts.artifacts
            (id, tenant_id, template_ref, inputs_json, output_blob_id, verification,
             state, produced_by_run_id, created_at, updated_at)
          values
            (${artifact.id}, ${artifact.tenantId},
             ${JSON.stringify(artifact.templateRef)}::text::jsonb,
             ${JSON.stringify(artifact.inputsJson)}::text::jsonb,
             ${artifact.outputBlobId}, null, ${artifact.state}, null, ${at}, ${at})`;
        const written = await insertEvidence(tx, p.tenantId, {
          producedBy: { kind: "principal", id: p.principalId },
          kind: "record",
          sources,
          summary:
            `Rendered '${template.slug}' v${template.version} into artifact ${artifact.id}: ` +
            `${usedFields.length} field(s) filled (${usedFields.join(", ") || "none"}), ` +
            `${output.length} characters out.`,
          blobIds: [outputRef.id],
          contentHash: sha256Hex(output),
          at,
        });
        await spine.append(tx, {
          tenantId: p.tenantId,
          topic: "artifact.rendered",
          subjectRefs: [
            { kind: "artifact", id: artifact.id },
            { kind: "template", id: template.id },
            { kind: "evidence", id: written.id },
          ],
          actor: { kind: "principal", id: p.principalId },
          payload: { templateSlug: template.slug },
        });
        return written;
      });

      return { artifact, evidence };
    },

    async verify(artifactId: Ulid, p: PrincipalContext): Promise<VerificationReport> {
      const artifact = await loadArtifact(artifactId, p.tenantId);
      const template = await loadTemplate(artifact.templateRef.id, p.tenantId);
      const output = new TextDecoder().decode(
        await contextStore.readBlob(p.tenantId, artifact.outputBlobId),
      );

      const results: { label: string; outcome: CheckOutcome }[] = [];
      for (const check of template.checks) {
        const outcome =
          check.kind === "deterministic"
            ? runDeterministicCheck(check.ref, {
                output,
                inputs: artifact.inputsJson,
                fieldsSchema: template.fieldsSchema,
              })
            : await runRubricCheck(check.prompt, output, {
                ...(deps.complete !== undefined ? { complete: deps.complete } : {}),
                model: deps.model,
              });
        results.push({ label: checkLabel(check), outcome });
      }

      const findings = results.map(
        (r) => `${r.outcome.passed ? "PASS" : "FAIL"} ${r.label} — ${r.outcome.detail}`,
      );
      if (template.checks.length === 0) {
        // Not a pass by omission: the report says out loud that nothing was asserted.
        findings.push(
          `NOTE template '${template.slug}' v${template.version} declares no checks — verification asserted nothing`,
        );
      }
      const passed = results.every((r) => r.outcome.passed);
      const at = nowIso();
      const contentHash = sha256Hex(
        JSON.stringify({ artifactId, outputSha: sha256Hex(output), results }),
      );

      const evidence = await db.withTx(async (tx) => {
        const written = await insertEvidence(tx, p.tenantId, {
          producedBy: { kind: "principal", id: p.principalId },
          kind: "verification",
          sources: [
            {
              ref: { kind: "artifact", id: artifact.id },
              whyRelevant: "The artifact whose checks were run.",
            },
            {
              ref: { kind: "blob", id: artifact.outputBlobId },
              whyRelevant: `The exact bytes checked, sha256 ${sha256Hex(output)}.`,
            },
            {
              ref: { kind: "template", id: template.id },
              locator: `${template.slug}@${template.version}`,
              whyRelevant: `The template declaring the ${template.checks.length} check(s) that were run.`,
            },
          ],
          summary:
            `Verification of artifact ${artifact.id}: ${passed ? "PASSED" : "FAILED"} ` +
            `(${results.filter((r) => r.outcome.passed).length}/${results.length} check(s) passed).`,
          blobIds: [artifact.outputBlobId],
          contentHash,
          at,
        });
        const verification = { passed, findings, evidenceId: written.id };
        await txSql(tx)`
          update artifacts.artifacts
          set verification = ${JSON.stringify(verification)}::text::jsonb,
              state = ${passed ? "verified" : "failed"}, updated_at = ${at}
          where id = ${artifact.id} and tenant_id = ${p.tenantId}`;
        await spine.append(tx, {
          tenantId: p.tenantId,
          topic: "artifact.verified",
          subjectRefs: [
            { kind: "artifact", id: artifact.id },
            { kind: "evidence", id: written.id },
          ],
          actor: { kind: "principal", id: p.principalId },
          payload: { passed },
        });
        return written;
      });

      return { artifactId: artifact.id, passed, findings, evidenceId: evidence.id };
    },
  };
}
