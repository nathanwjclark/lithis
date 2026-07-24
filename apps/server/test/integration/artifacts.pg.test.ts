import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUlid, nowIso } from "@lithis/core";
import type { Origin, PrincipalContext } from "@lithis/core";
import { getEvidence } from "../../src/agents";
import type { CompleteFn } from "../../src/agents";
import { createArtifactEngine } from "../../src/artifacts";
import type { ArtifactEngine } from "../../src/artifacts";
import { TemplateNotApprovedError } from "../../src/artifacts";
import { createContextStore, createLocalBlobStorage } from "../../src/context";
import type { ContextStore } from "../../src/context";
import { createHumanGate } from "../../src/humangate";
import type { HumanGate } from "../../src/humangate";
import { createEventSpine } from "../../src/spine";
import type { EventSpine } from "../../src/spine";
import type { Db } from "../../src/db";
import { describePg, freshDb, truncateAll } from "../helpers/pg";

/**
 * P11 acceptance over real Postgres — "render + verify an artifact":
 *   1. a real template blob renders with real inputs (the gate must be
 *      approved first), and the render Evidence row exists;
 *   2. verification runs the template's checks, writes an Evidence record of
 *      kind 'verification', and moves the artifact to `verified`;
 *   3. a failing check yields passed:false with findings and state `failed`;
 *   4. an unapproved template cannot render; an unknown check ref can never
 *      pass; a rubric with no model configured is skipped and therefore fails.
 * Real spine, humangate, context store and engine throughout — only the LLM
 * seam and the template bodies are fixtures, which is exactly where fixtures
 * belong.
 */

const blobDir = mkdtempSync(join(tmpdir(), "lithis-artifacts-it-"));

const RENEWAL_BODY = `# Renewal review — {{client_name}}

Policy **{{policy_number}}** with {{carrier}} expires on {{expiration_date}}.

## Coverage lines
{{#each coverages}}
- {{line}} — limit {{limit}}, premium {{premium}}
{{/each}}

Prepared by {{preparer}} for internal review.
`;

const RENEWAL_FIELDS = {
  type: "object",
  properties: {
    client_name: { type: "string" },
    policy_number: { type: "string" },
    carrier: { type: "string" },
    expiration_date: { type: "string" },
    preparer: { type: "string" },
    coverages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line: { type: "string" },
          limit: { type: "string" },
          premium: { type: "number" },
        },
        required: ["line", "limit", "premium"],
      },
    },
  },
  required: ["client_name", "policy_number", "carrier", "expiration_date", "preparer", "coverages"],
};

const RENEWAL_INPUTS = {
  client_name: "Harbour Freight Logistics LLC",
  policy_number: "GL-99120",
  carrier: "Meridian Casualty",
  expiration_date: "2026-11-01",
  preparer: "Dana Okafor",
  coverages: [
    { line: "General Liability", limit: "$2,000,000", premium: 41250 },
    { line: "Commercial Auto", limit: "$1,000,000", premium: 18900 },
  ],
};

interface Rig {
  db: Db;
  spine: EventSpine;
  gate: HumanGate;
  store: ContextStore;
  engine: ArtifactEngine;
  tenantId: string;
  principalId: string;
  p: PrincipalContext;
  origin: Origin;
}

async function buildRig(complete?: CompleteFn): Promise<Rig> {
  const db = await freshDb();
  const spine = createEventSpine(db);
  const gate = createHumanGate(db, spine);
  const store = createContextStore(db, spine, { blobs: createLocalBlobStorage(blobDir) });
  const tenantId = newUlid();
  const principalId = newUlid();
  const engine = createArtifactEngine({
    db,
    spine,
    humanGate: gate,
    contextStore: store,
    config: {},
    ...(complete !== undefined ? { complete } : {}),
  });
  return {
    db,
    spine,
    gate,
    store,
    engine,
    tenantId,
    principalId,
    p: { tenantId, principalId, kind: "human" },
    origin: {
      by: { kind: "principal", id: principalId },
      method: "human",
      trust: "internal",
      at: nowIso(),
    },
  };
}

async function putBody(rig: Rig, body: string): Promise<string> {
  const ref = await rig.store.putBlob(
    { tenantId: rig.tenantId, mediaType: "text/markdown", origin: rig.origin },
    new TextEncoder().encode(body),
  );
  return ref.id;
}

async function approve(rig: Rig, requestId: string): Promise<void> {
  await rig.gate.resolve(
    requestId,
    {
      by: { kind: "principal", id: rig.principalId },
      at: nowIso(),
      verdict: "approved",
      comment: "reviewed the body checksum and the field diff",
    },
    rig.p,
  );
}

describePg("P11 artifacts over Postgres", () => {
  beforeEach(async () => {
    await truncateAll(await freshDb());
  });

  test("template change gates, then a real template renders + verifies with Evidence", async () => {
    const rig = await buildRig();
    const bodyBlobId = await putBody(rig, RENEWAL_BODY);

    const proposal = await rig.engine.createTemplate(
      {
        tenantId: rig.tenantId,
        slug: "renewal-review",
        version: "1.0.0",
        kind: "document",
        fieldsSchema: RENEWAL_FIELDS,
        bodyBlobId,
        checks: [
          { kind: "deterministic", ref: "no-unfilled-placeholders" },
          { kind: "deterministic", ref: "required-fields" },
          { kind: "deterministic", ref: "no-todo-markers" },
          { kind: "deterministic", ref: "length-bounds:min=120,max=8000" },
        ],
      },
      rig.p,
    );
    expect(proposal.approvalRequestId).toBeString();

    // The gate is real: the template cannot render until a human approves it.
    const request = await rig.gate.get(proposal.approvalRequestId!, rig.tenantId);
    expect(request?.subjectKind).toBe("template_change");
    expect(request?.state).toBe("pending");
    const payload = request!.payload as Record<string, unknown>;
    expect(payload["slug"]).toBe("renewal-review");
    expect(payload["bodyChecksum"]).toBeString();
    expect(payload["unknownCheckRefs"]).toEqual([]);
    expect(payload["fieldsAdded"]).toContain("coverages");

    await expect(
      rig.engine.render({ id: proposal.template.id, version: "1.0.0" }, RENEWAL_INPUTS, rig.p),
    ).rejects.toThrow(TemplateNotApprovedError);

    await approve(rig, proposal.approvalRequestId!);

    const { artifact, evidence } = await rig.engine.render(
      { id: proposal.template.id, version: "1.0.0" },
      RENEWAL_INPUTS,
      rig.p,
    );
    expect(artifact.state).toBe("draft");
    expect(artifact.templateRef).toEqual({ id: proposal.template.id, version: "1.0.0" });

    // The rendered bytes are real, deterministic, and fully filled.
    const output = new TextDecoder().decode(
      await rig.store.readBlob(rig.tenantId, artifact.outputBlobId),
    );
    expect(output).toContain("# Renewal review — Harbour Freight Logistics LLC");
    expect(output).toContain("- General Liability — limit $2,000,000, premium 41250");
    expect(output).toContain("- Commercial Auto — limit $1,000,000, premium 18900");
    expect(output).not.toContain("{{");

    // The render evidence is a real row in the agents module's table.
    const renderEvidence = await getEvidence(rig.db, rig.tenantId, evidence.id);
    expect(renderEvidence?.kind).toBe("record");
    expect(renderEvidence?.blobIds).toContain(artifact.outputBlobId);
    expect(renderEvidence?.sources.map((s) => s.ref.kind).sort()).toEqual([
      "blob",
      "blob",
      "template",
    ]);

    const report = await rig.engine.verify(artifact.id, rig.p);
    expect(report.passed).toBe(true);
    expect(report.findings).toHaveLength(4);
    expect(report.findings.every((f) => f.startsWith("PASS "))).toBe(true);

    // Verification IS Evidence.
    const verification = await getEvidence(rig.db, rig.tenantId, report.evidenceId);
    expect(verification?.kind).toBe("verification");
    expect(verification?.summary).toContain("PASSED");
    expect(verification?.contentHash).toBeString();

    const stored = await rig.engine.getArtifact(artifact.id, rig.tenantId);
    expect(stored?.state).toBe("verified");
    expect(stored?.verification?.passed).toBe(true);
    expect(stored?.verification?.evidenceId).toBe(report.evidenceId);

    // Both lifecycle events landed on the spine.
    const events = await rig.spine.readSince({
      consumerId: "test",
      tenantId: rig.tenantId,
      afterSeq: 0n,
    });
    const topics = events.map((e) => e.topic);
    expect(topics).toContain("artifact.template.created");
    expect(topics).toContain("artifact.template.change_proposed");
    expect(topics).toContain("artifact.rendered");
    expect(topics).toContain("artifact.verified");
  });

  test("a failing check yields passed:false with findings and state 'failed'", async () => {
    const rig = await buildRig();
    // A template whose body legitimately renders, but whose checks it cannot satisfy.
    const bodyBlobId = await putBody(rig, "Quote for {{client_name}}: premium TBD.\n");
    const proposal = await rig.engine.createTemplate(
      {
        tenantId: rig.tenantId,
        slug: "quote-stub",
        version: "1.0.0",
        kind: "document",
        fieldsSchema: { type: "object", properties: { client_name: { type: "string" } }, required: ["client_name"] },
        bodyBlobId,
        checks: [
          { kind: "deterministic", ref: "no-todo-markers" },
          { kind: "deterministic", ref: "length-bounds:min=5000" },
          { kind: "deterministic", ref: "totally-made-up-check" },
          { kind: "rubric", prompt: "Does the quote state a premium figure?" },
        ],
      },
      rig.p,
    );
    // The approver is warned about the unresolvable check ref up front.
    const request = await rig.gate.get(proposal.approvalRequestId!, rig.tenantId);
    expect((request!.payload as Record<string, unknown>)["unknownCheckRefs"]).toEqual([
      "totally-made-up-check",
    ]);
    expect(request!.summary).toContain("will always FAIL verification");
    await approve(rig, proposal.approvalRequestId!);

    const { artifact } = await rig.engine.render(
      { id: proposal.template.id, version: "1.0.0" },
      { client_name: "Acme Haulage" },
      rig.p,
    );
    const report = await rig.engine.verify(artifact.id, rig.p);

    expect(report.passed).toBe(false);
    const joined = report.findings.join("\n");
    expect(joined).toContain("FAIL deterministic:no-todo-markers");
    expect(joined).toContain("FAIL deterministic:length-bounds:min=5000");
    expect(joined).toContain("unknown deterministic check ref 'totally-made-up-check'");
    // No model configured ⇒ the rubric is skipped, and a skipped check cannot pass.
    expect(joined).toContain("FAIL rubric:");
    expect(joined).toContain("SKIPPED");

    const stored = await rig.engine.getArtifact(artifact.id, rig.tenantId);
    expect(stored?.state).toBe("failed");
    expect(stored?.verification?.passed).toBe(false);
    const evidence = await getEvidence(rig.db, rig.tenantId, report.evidenceId);
    expect(evidence?.kind).toBe("verification");
    expect(evidence?.summary).toContain("FAILED");
  });

  test("a scripted model makes rubric checks real; bad inputs never render", async () => {
    let seen = "";
    const complete: CompleteFn = async (req) => {
      seen = String(req.messages[0]?.content ?? "");
      return {
        content: [
          {
            type: "text",
            text: '{"pass": true, "reason": "the expiry date is stated"}',
            citations: null,
          },
        ],
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    };
    const rig = await buildRig(complete);
    const bodyBlobId = await putBody(rig, "Policy {{policy_number}} expires {{expiration_date}}.\n");
    const proposal = await rig.engine.createTemplate(
      {
        tenantId: rig.tenantId,
        slug: "expiry-note",
        version: "1.0.0",
        kind: "email",
        fieldsSchema: {
          type: "object",
          properties: { policy_number: { type: "string" }, expiration_date: { type: "string" } },
          required: ["policy_number", "expiration_date"],
        },
        bodyBlobId,
        checks: [{ kind: "rubric", prompt: "Does the note state an expiry date?" }],
      },
      rig.p,
    );
    await approve(rig, proposal.approvalRequestId!);

    // Inputs are validated against the template's own schema before anything renders.
    await expect(
      rig.engine.render({ id: proposal.template.id, version: "1.0.0" }, { policy_number: 7 }, rig.p),
    ).rejects.toThrow(/expected string, got number/);

    const { artifact } = await rig.engine.render(
      { id: proposal.template.id, version: "1.0.0" },
      { policy_number: "GL-1", expiration_date: "2026-11-01" },
      rig.p,
    );
    const report = await rig.engine.verify(artifact.id, rig.p);
    expect(report.passed).toBe(true);
    expect(report.findings[0]).toContain("the expiry date is stated");
    // The rubric saw the ACTUAL rendered bytes, not the template.
    expect(seen).toContain("Policy GL-1 expires 2026-11-01.");
  });

  test("image templates hit the loud stub instead of degrading to text", async () => {
    const rig = await buildRig();
    const bodyBlobId = await putBody(rig, "banner for {{client_name}}\n");
    const proposal = await rig.engine.createTemplate(
      {
        tenantId: rig.tenantId,
        slug: "client-banner",
        version: "1.0.0",
        kind: "image",
        fieldsSchema: { type: "object", properties: { client_name: { type: "string" } }, required: ["client_name"] },
        bodyBlobId,
        approvalPolicy: "none",
      },
      rig.p,
    );
    expect(proposal.approvalRequestId).toBeUndefined();
    await expect(
      rig.engine.render({ id: proposal.template.id, version: "1.0.0" }, { client_name: "Acme" }, rig.p),
    ).rejects.toThrow(/server\.artifacts\.engine\.render\.visual/);
  });

  test("a template body referencing an undeclared field is rejected at registration", async () => {
    const rig = await buildRig();
    const bodyBlobId = await putBody(rig, "Hello {{client_name}} about {{unexpected_field}}.\n");
    await expect(
      rig.engine.createTemplate(
        {
          tenantId: rig.tenantId,
          slug: "typo-template",
          version: "1.0.0",
          kind: "document",
          fieldsSchema: { type: "object", properties: { client_name: { type: "string" } } },
          bodyBlobId,
        },
        rig.p,
      ),
    ).rejects.toThrow(/does not declare: unexpected_field/);
  });
});
