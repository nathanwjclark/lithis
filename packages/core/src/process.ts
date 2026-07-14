import { z } from "zod";
import { recordBase, slugSchema } from "./common";
import { ulidSchema } from "./ids";
import { refSchema } from "./refs";

/**
 * Process orchestration: authored, versioned templates (fixed / adaptive /
 * dynamic) instantiated into runs whose nodes ARE WorkItems (kind:
 * process_node) — node state lives on the WorkItem; there is no second state
 * machine here. WatchRules are bound per-instance at instantiate() so "new
 * information arrived" matches against THIS case's entities and doc types.
 */

export const PROCESS_MODES = ["fixed", "adaptive", "dynamic"] as const;

/** What a node needs from the world — resolved into the RunBrief's context slice. */
export const selectorSpecSchema = z.object({
  description: z.string().min(1),
  docTypes: z.array(slugSchema).optional(),
  entityRefs: z.array(refSchema).optional(),
  /** Upstream node keys whose results feed this node. */
  fromNodes: z.array(z.string()).optional(),
  query: z.string().optional(),
});
export type SelectorSpec = z.infer<typeof selectorSpecSchema>;

export const GATE_MODES = ["always", "auto_below_threshold", "never"] as const;

export const nodeDefSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  instructions: z.string().min(1),
  /** Optional skill executing this node (else the owning agent works from instructions). */
  skillRef: refSchema.optional(),
  inputSelectors: z.array(selectorSpecSchema).default([]),
  /** Ref to the zod/JSON schema the node's resultJson must validate against. */
  resultSchemaRef: z.string(),
  gate: z.enum(GATE_MODES),
  /** What evidence the node is expected to produce for its reviewers. */
  evidenceSpec: z.string().optional(),
});
export type NodeDef = z.infer<typeof nodeDefSchema>;

export const processTemplateSchema = z
  .object({
    ...recordBase,
    slug: slugSchema,
    version: z.string().min(1),
    mode: z.enum(PROCESS_MODES),
    nodes: z.array(nodeDefSchema).min(1),
    edges: z.array(
      z.object({
        from: z.string(),
        to: z.string(),
        kind: z.literal("depends_on"),
      }),
    ),
    /** What instance-level graph changes are allowed (adaptive/dynamic modes). */
    changePolicy: z.object({
      allowAddNodes: z.boolean(),
      allowSkip: z.boolean(),
      protectedNodes: z.array(z.string()).default([]),
    }),
    /** Template changes gate through the ONE human primitive. */
    approvalRequestId: ulidSchema.optional(),
  })
  .superRefine((template, ctx) => {
    const keys = new Set(template.nodes.map((n) => n.key));
    if (keys.size !== template.nodes.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes"], message: "duplicate node keys" });
    }
    for (const [i, edge] of template.edges.entries()) {
      if (!keys.has(edge.from) || !keys.has(edge.to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", i],
          message: `edge references unknown node key '${edge.from}'→'${edge.to}'`,
        });
      }
    }
  });
export type ProcessTemplate = z.infer<typeof processTemplateSchema>;

export const processRunSchema = z.object({
  ...recordBase,
  /** Null template = fully dynamic run (graph minted by the orchestrating agent). */
  templateRef: z.object({ id: ulidSchema, version: z.string() }).optional(),
  /** What this run is about (the underwriting case entity, the filing doc, ...). */
  subjectRef: refSchema,
  status: z.enum(["active", "paused", "done", "cancelled"]),
  /** Bumped on every instance-graph change (adaptive/dynamic). */
  graphRevision: z.number().int().nonnegative(),
});
export type ProcessRun = z.infer<typeof processRunSchema>;

export const watchRuleSchema = z.object({
  id: ulidSchema,
  tenantId: ulidSchema,
  processRunId: ulidSchema,
  nodeKey: z.string(),
  match: z.object({
    topics: z.array(z.string()).min(1),
    docTypes: z.array(slugSchema).optional(),
    entityRefs: z.array(refSchema).optional(),
    pathGlobs: z.array(z.string()).optional(),
    connectorKinds: z.array(slugSchema).optional(),
  }),
  /** deterministic = code decides; interpret = one LLM run asserts the cause (evented, confidence-gated). */
  mode: z.enum(["deterministic", "interpret"]),
});
export type WatchRule = z.infer<typeof watchRuleSchema>;

/** Why a node must rerun. The Invalidator (pure code) is the ONLY writer of 'stale'. */
export const invalidationCauseSchema = z.object({
  kind: z.enum(["denial", "modification", "watch_deterministic", "watch_interpreted"]),
  processRunId: ulidSchema,
  nodeKey: z.string(),
  /** The triggering spine event (new doc, resolution, interpreter assertion). */
  eventId: ulidSchema.optional(),
  humanRequestId: ulidSchema.optional(),
  comment: z.string().optional(),
});
export type InvalidationCause = z.infer<typeof invalidationCauseSchema>;

export const cascadePlanSchema = z.object({
  processRunId: ulidSchema,
  dirtyNodeKey: z.string(),
  /** Transitive depends_on dependents that go stale. */
  affected: z.array(z.string()),
  width: z.number().int().nonnegative(),
  /** The triggering spine event, threaded through to humangate.superseded payloads. */
  causeEventId: ulidSchema.optional(),
});
export type CascadePlan = z.infer<typeof cascadePlanSchema>;
