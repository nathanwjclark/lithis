import { z } from "zod";
import { revisioned, recordBase } from "./common";
import { cronSchema, isoDateTimeSchema, ulidSchema } from "./ids";
import { refSchema } from "./refs";
import type { TransitionTable } from "./transitions";

/**
 * ONE work graph (pillars 3+4 merged): the global agent task list and
 * process-orchestration nodes are the same table with the same state machine
 * and the same claim protocol. The WorkItem table IS the job queue
 * (FOR UPDATE SKIP LOCKED + lease/heartbeat).
 */

export const WORK_ITEM_KINDS = ["oneoff", "recurring", "continuous", "process_node"] as const;

export const WORK_ITEM_STATUSES = [
  "pending",
  "ready",
  "claimed",
  "running",
  "awaiting_approval",
  "blocked",
  "failed",
  "done",
  "stale",
  "cancelled",
] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

/**
 * The authoritative transition table (tested exhaustively). Notes:
 * - pending→ready happens when all depends_on upstreams are done (ENFORCED) or wakeAt fires.
 * - Only the Invalidator writes done→stale / awaiting_approval→stale (cascade).
 * - awaiting_approval→ready is a human deny/modify: result superseded, rework brief carries the comment.
 */
export const WORK_ITEM_TRANSITIONS: TransitionTable<WorkItemStatus> = {
  pending: ["ready", "cancelled"],
  ready: ["claimed", "pending", "cancelled"],
  claimed: ["running", "ready", "cancelled"],
  running: ["done", "awaiting_approval", "blocked", "failed", "ready", "cancelled"],
  awaiting_approval: ["done", "ready", "stale", "cancelled"],
  blocked: ["ready", "cancelled"],
  failed: ["ready", "cancelled"],
  done: ["stale"],
  stale: ["pending", "ready", "cancelled"],
  cancelled: [],
};

export const workItemFollowUpSchema = z.object({
  /** The EXTERNAL party being followed up with (an Entity, not a Principal). */
  counterpartRef: refSchema.refine((r) => r.kind === "entity", {
    message: "followUp.counterpartRef must reference an entity (external party)",
  }),
  cadence: cronSchema,
  nextAt: isoDateTimeSchema,
  lastContactAt: isoDateTimeSchema.optional(),
  escalateAfterDays: z.number().int().positive().optional(),
  escalateToPrincipalId: ulidSchema.optional(),
});
export type WorkItemFollowUp = z.infer<typeof workItemFollowUpSchema>;

export const workItemLeaseSchema = z.object({
  holderPrincipalId: ulidSchema,
  runId: ulidSchema,
  expiresAt: isoDateTimeSchema,
  heartbeatAt: isoDateTimeSchema,
});
export type WorkItemLease = z.infer<typeof workItemLeaseSchema>;

export const workItemSchema = z.object({
  ...revisioned,
  kind: z.enum(WORK_ITEM_KINDS),
  title: z.string().min(1),
  body: z.string().default(""),
  status: z.enum(WORK_ITEM_STATUSES),
  ownerPrincipalId: ulidSchema,
  priority: z.number().min(0).max(1).default(0.5),
  dueAt: isoDateTimeSchema.optional(),
  /** Continuous items sleep until here; the clock flips pending→ready. */
  wakeAt: isoDateTimeSchema.optional(),
  /** Recurring items: the clock mints oneoff occurrence children on this cron. */
  schedule: cronSchema.optional(),
  followUp: workItemFollowUpSchema.optional(),
  /** Set when kind = process_node. */
  processRunId: ulidSchema.optional(),
  nodeKey: z.string().optional(),
  attempt: z.number().int().nonnegative().default(0),
  lease: workItemLeaseSchema.optional(),
  /** What spawned this item (an event, a doc, a human ask). */
  sourceRefs: z.array(refSchema).default([]),
});
export type WorkItem = z.infer<typeof workItemSchema>;

export const WORK_EDGE_VERBS = ["depends_on", "subtask_of"] as const;

export const workEdgeSchema = z.object({
  ...recordBase,
  fromId: ulidSchema,
  toId: ulidSchema,
  verb: z.enum(WORK_EDGE_VERBS),
});
export type WorkEdge = z.infer<typeof workEdgeSchema>;

/** Append-only journal on a work item (status notes, human comments, system notes). */
export const workNoteSchema = z.object({
  id: ulidSchema,
  tenantId: ulidSchema,
  workItemId: ulidSchema,
  at: isoDateTimeSchema,
  byRef: refSchema,
  kind: z.enum(["status", "human", "system"]),
  text: z.string().min(1),
});
export type WorkNote = z.infer<typeof workNoteSchema>;
