import { z } from "zod";
import { costSchema, recordBase } from "./common";
import { isoDateTimeSchema, ulidSchema } from "./ids";
import { refSchema } from "./refs";

/**
 * Runs & evidence. A Run is one agent execution inside a Session; RunResults
 * are per-attempt and superseded (never overwritten) by cascades; Evidence is
 * immutable and citable — what the agent saw and highlighted, for the human
 * reviewing the result.
 */

export const RUN_TRIGGER_CAUSES = [
  "initial",
  "schedule",
  "event",
  "human",
  "denial",
  "modification",
  "new_information",
  "upstream_invalidation",
] as const;

export const RUN_STATUSES = [
  "running",
  "done",
  "blocked",
  "human_blocked",
  "needs_decomposition",
  "failed",
  "cancelled",
] as const;

export const runSchema = z.object({
  ...recordBase,
  principalId: ulidSchema,
  /** Every run happens inside a Session. */
  sessionId: ulidSchema,
  workItemId: ulidSchema.optional(),
  model: z.string().min(1),
  trigger: z.object({
    cause: z.enum(RUN_TRIGGER_CAUSES),
    eventId: ulidSchema.optional(),
  }),
  status: z.enum(RUN_STATUSES),
  transcriptBlobId: ulidSchema.optional(),
  workspaceRef: refSchema.optional(),
  cost: costSchema,
  startedAt: isoDateTimeSchema,
  endedAt: isoDateTimeSchema.optional(),
});
export type Run = z.infer<typeof runSchema>;

export const runResultSchema = z.object({
  ...recordBase,
  runId: ulidSchema,
  workItemId: ulidSchema,
  attempt: z.number().int().nonnegative(),
  /** Validated against the node's resultSchemaRef at the module layer. */
  resultJson: z.unknown(),
  summary: z.string().min(1),
  evidenceIds: z.array(ulidSchema).default([]),
  /** Exactly what this result was computed from. */
  inputRefs: z.array(refSchema).default([]),
  /**
   * sha256 over sorted [refKind, refId, contentDigest] tuples — the rerun
   * short-circuit (equal hash downstream ⇒ "no change" evidence + auto-approve
   * on auto_below_threshold gates). A suppressor, never an invalidation authority.
   */
  inputsHash: z.string(),
  superseded: z.boolean().default(false),
  supersededByRunId: ulidSchema.optional(),
});
export type RunResult = z.infer<typeof runResultSchema>;

export const EVIDENCE_KINDS = [
  "excerpt",
  "screenshot",
  "record",
  "metric",
  "page_capture",
  "diff",
  "verification",
  "proposed_action",
] as const;

export const evidenceSourceSchema = z.object({
  ref: refSchema,
  /** Where in the source: a text span, a DOM selector, a page number, an image region. */
  locator: z.string().optional(),
  excerpt: z.string().optional(),
  whyRelevant: z.string().min(1),
});
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

export const evidenceSchema = z.object({
  ...recordBase,
  runId: ulidSchema.optional(),
  /** A principal or a run — deterministic checks produce evidence without an agent run. */
  producedBy: refSchema,
  kind: z.enum(EVIDENCE_KINDS),
  sources: z.array(evidenceSourceSchema).min(1),
  summary: z.string().min(1),
  blobIds: z.array(ulidSchema).default([]),
  /** Immutable: content-addressed, never edited after creation. */
  contentHash: z.string(),
  at: isoDateTimeSchema,
});
export type Evidence = z.infer<typeof evidenceSchema>;

/** What the executor hands an agent for one run. */
export const runBriefSchema = z.object({
  tenantId: ulidSchema,
  principalId: ulidSchema,
  workItemId: ulidSchema.optional(),
  /** Rendered context slice (graph neighborhood, upstream results, memory). */
  contextSlice: z.string(),
  /** On denial/modification reruns: the reviewer's comment + modification. */
  reworkInput: z
    .object({
      comment: z.string(),
      modification: z.unknown().optional(),
    })
    .optional(),
  resultSchemaRef: z.string().optional(),
  budget: z.object({ usd: z.number().positive(), maxMinutes: z.number().positive() }),
});
export type RunBrief = z.infer<typeof runBriefSchema>;

/** What comes back from one run. */
export const runOutcomeSchema = z.object({
  status: z.enum(RUN_STATUSES).exclude(["running"]),
  resultJson: z.unknown().optional(),
  evidenceDrafts: z
    .array(evidenceSchema.omit({ id: true, tenantId: true, createdAt: true, updatedAt: true }))
    .default([]),
  newTasks: z
    .array(z.object({ title: z.string().min(1), body: z.string().default(""), priority: z.number().min(0).max(1).optional() }))
    .default([]),
  blocker: z.string().optional(),
  cost: costSchema,
  transcriptRef: z.string().optional(),
});
export type RunOutcome = z.infer<typeof runOutcomeSchema>;
