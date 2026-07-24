import type { Artifact, Evidence, PrincipalContext, Template, Ulid } from "@lithis/core";
import { stub } from "@lithis/stubkit";
import { DEFAULT_AGENT_MODEL } from "../agents";
import type { CompleteFn } from "../agents";
import type { ServerConfig } from "../config";
import type { ContextStore } from "../context";
import type { Db } from "../db";
import type { HumanGate } from "../humangate";
import type { EventSpine } from "../spine";
import { createPgArtifactEngine } from "./service";

/**
 * artifacts — template-driven document/email/report generation plus
 * verification. Verification IS Evidence (kind 'verification', written into
 * the agents module's evidence table through its published surface); template
 * changes gate through HumanRequest{template_change}.
 *
 * REAL as of phase P11 — see render.ts (the strict, dependency-free renderer:
 * `{{field}}` + `{{#each}}`, where an unfilled or unknown placeholder is an
 * ERROR, never a blank), fields.ts (the strict JSON-Schema subset validator —
 * unsupported keywords are loud, not ignored), checks.ts (the named
 * deterministic check registry + the rubric seam), and service.ts (the
 * Postgres engine).
 *
 * `image`/`video` kinds have no honest implementation here and render through
 * the loud stub below rather than degrading to text.
 */

export interface ArtifactTemplateRef {
  id: Ulid;
  version: string;
}

export type TemplateCheck = Template["checks"][number];

/** A template version before the engine assigns id/timestamps. */
export interface TemplateDraft {
  tenantId: Ulid;
  slug: string;
  version: string;
  kind: Template["kind"];
  /** JSON Schema (the strict subset in fields.ts) for the fill-in fields. */
  fieldsSchema: Record<string, unknown>;
  /** Context-store blob holding the template body. */
  bodyBlobId: Ulid;
  checks?: TemplateCheck[];
  /** Default 'always' — the gated path is the default path. */
  approvalPolicy?: "none" | "always";
}

export interface TemplateProposal {
  template: Template;
  /** Present when approvalPolicy is 'always': the template_change gate. */
  approvalRequestId?: Ulid;
}

export interface VerificationReport {
  artifactId: Ulid;
  passed: boolean;
  findings: string[];
  /** The evidence record documenting exactly what was checked. */
  evidenceId: Ulid;
}

export interface ArtifactEngine {
  /**
   * Register a template version. With `approvalPolicy: 'always'` (the default)
   * the version is written but UNUSABLE until its HumanRequest
   * {subjectKind:'template_change'} is approved.
   */
  createTemplate(draft: TemplateDraft, p: PrincipalContext): Promise<TemplateProposal>;
  listTemplates(tenantId: Ulid): Promise<Template[]>;
  getTemplate(id: Ulid, tenantId: Ulid): Promise<Template | undefined>;
  getArtifact(id: Ulid, tenantId: Ulid): Promise<Artifact | undefined>;
  /** Fill + render a template; the draft artifact arrives with its render evidence. */
  render(
    t: ArtifactTemplateRef,
    inputs: unknown,
    p: PrincipalContext,
  ): Promise<{ artifact: Artifact; evidence: Evidence }>;
  /**
   * Runs the template's deterministic + rubric checks; result is an Evidence
   * record. Takes the caller's PrincipalContext (P11 signature change): every
   * read here is tenant-scoped in SQL, never post-filtered.
   */
  verify(artifactId: Ulid, p: PrincipalContext): Promise<VerificationReport>;
}

/**
 * Image/video artifacts have no honest implementation: nothing in this build
 * generates or composes media, and emitting a text file for an `image`
 * template would be exactly the silent-placeholder failure this repo exists to
 * avoid. render() CALLS this for those kinds, so the census counts real hits.
 */
export const renderVisualArtifact = stub<(t: ArtifactTemplateRef, inputs: unknown, p: PrincipalContext) => Promise<never>>(
  "server.artifacts.engine.render.visual",
  "LITHIS-STUB: image/video artifact rendering not implemented — no media generation/composition backend is wired; document/email/report render as text/markdown today",
);

export interface ArtifactsRuntimeDeps {
  db: Db;
  spine: EventSpine;
  humanGate: HumanGate;
  /** Template bodies and rendered outputs are blobs. */
  contextStore: ContextStore;
  config: Pick<ServerConfig, "anthropicApiKey" | "agentModel">;
  /** Injectable LLM seam for rubric checks; tests script it. */
  complete?: CompleteFn;
}

/** Wire the real engine over shared deps (main.ts and integration tests). */
export function createArtifactEngine(deps: ArtifactsRuntimeDeps): ArtifactEngine {
  return createPgArtifactEngine({
    db: deps.db,
    spine: deps.spine,
    humanGate: deps.humanGate,
    contextStore: deps.contextStore,
    ...(deps.complete !== undefined ? { complete: deps.complete } : {}),
    model: deps.config.agentModel ?? DEFAULT_AGENT_MODEL,
  });
}

/**
 * DB-less skeleton mode (DATABASE_URL unset): the engine cannot run. Honest
 * CONFIG degrade, not a stub — the real implementation exists and is wired
 * whenever a database is configured.
 */
export function createUnconfiguredArtifactEngine(): ArtifactEngine {
  const fail = (): never => {
    throw new Error(
      "artifact engine unavailable: DATABASE_URL is not set — the server is running in DB-less skeleton mode",
    );
  };
  return {
    createTemplate: fail,
    listTemplates: fail,
    getTemplate: fail,
    getArtifact: fail,
    render: fail,
    verify: fail,
  };
}

export {
  DETERMINISTIC_CHECKS,
  DETERMINISTIC_CHECK_REFS,
  parseCheckRef,
  parseRubricVerdict,
  runDeterministicCheck,
  runRubricCheck,
} from "./checks";
export type { CheckContext, CheckOutcome, DeterministicCheck } from "./checks";
export {
  FieldsSchemaUnsupportedError,
  FieldsValidationError,
  assertSupportedFieldsSchema,
  requiredFields,
  validateInputs,
} from "./fields";
export {
  TemplateRenderError,
  collectRootFields,
  findResidualPlaceholders,
  renderTemplate,
  tokenize,
} from "./render";
export type { RenderResult } from "./render";
export {
  ArtifactNotFoundError,
  TemplateNotApprovedError,
  TemplateNotFoundError,
  templateChangePayloadSchema,
} from "./service";
export type { TemplateChangePayload } from "./service";
