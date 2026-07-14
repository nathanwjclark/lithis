import { z } from "zod";
import { recordBase } from "./common";
import { isoDateTimeSchema, ulidSchema } from "./ids";
import { refSchema } from "./refs";
import type { TransitionTable } from "./transitions";

/**
 * HumanRequest — THE human-in-the-loop primitive, reused by every flow that
 * needs a person: node result gates, risky actions, outreach batches, cascade
 * plans, skill/template changes, SoR migrations, watcher findings,
 * record-field questions. External-party follow-ups are NOT HumanRequests —
 * they live on WorkItem.followUp.
 */

export const HUMAN_REQUEST_KINDS = ["approval", "question", "notification"] as const;

/** CLOSED enum — each subjectKind pins a zod payload at the module layer. */
export const HUMAN_REQUEST_SUBJECT_KINDS = [
  "node_result",
  "action",
  "action_batch",
  "cascade_plan",
  "skill_change",
  "template_change",
  "sor_migration",
  "watcher_finding",
  "record_field",
] as const;

export const HUMAN_REQUEST_STATES = [
  "pending",
  "approved",
  "denied",
  "modified",
  "answered",
  "acknowledged",
  "expired",
  "superseded",
] as const;
export type HumanRequestState = (typeof HUMAN_REQUEST_STATES)[number];

/**
 * pending is the only live state; every resolution verb is terminal.
 * superseded happens when a cascade invalidates the thing being reviewed —
 * original approvers are notified (humangate.superseded event).
 */
export const HUMAN_REQUEST_TRANSITIONS: TransitionTable<HumanRequestState> = {
  pending: ["approved", "denied", "modified", "answered", "acknowledged", "expired", "superseded"],
  approved: ["superseded"],
  denied: [],
  modified: ["superseded"],
  answered: [],
  acknowledged: [],
  expired: [],
  superseded: [],
};

export const humanRequestRoutingSchema = z.object({
  /** A specific principal ref or a role name. SLA machinery is for INTERNAL responders only. */
  assignee: z.union([refSchema, z.string().min(1)]),
  channelPrefs: z.array(z.enum(["portal", "slack", "teams", "email"])).default(["portal"]),
  slaHours: z.number().positive().optional(),
  escalationPath: z.array(z.union([refSchema, z.string().min(1)])).default([]),
  followUpCount: z.number().int().nonnegative().default(0),
  nextFollowUpAt: isoDateTimeSchema.optional(),
});

export const humanResolutionSchema = z.object({
  by: refSchema,
  at: isoDateTimeSchema,
  verdict: z.enum(["approved", "denied", "modified", "answered", "acknowledged"]),
  /** Always present — deny-comments have a first-class home. */
  comment: z.string(),
  modification: z.unknown().optional(),
  /** Per-item verdicts for action_batch subjects. */
  perItem: z
    .array(
      z.object({
        intentId: ulidSchema,
        verdict: z.enum(["approved", "denied", "modified"]),
        modification: z.unknown().optional(),
      }),
    )
    .optional(),
});
export type HumanResolution = z.infer<typeof humanResolutionSchema>;

export const humanRequestSchema = z.object({
  ...recordBase,
  kind: z.enum(HUMAN_REQUEST_KINDS),
  subjectKind: z.enum(HUMAN_REQUEST_SUBJECT_KINDS),
  subjectRef: refSchema,
  /** Shape pinned per subjectKind at the module layer. */
  payload: z.unknown(),
  evidenceIds: z.array(ulidSchema).default([]),
  summary: z.string().min(1),
  /** Optional preset choices rendered as buttons on the card. */
  options: z.array(z.string()).optional(),
  routing: humanRequestRoutingSchema,
  state: z.enum(HUMAN_REQUEST_STATES),
  resolution: humanResolutionSchema.optional(),
  requestedBy: refSchema,
});
export type HumanRequest = z.infer<typeof humanRequestSchema>;
