import { z } from "zod";
import { ulidSchema } from "../ids";
import { refSchema } from "../refs";
import { defineEventType } from "../events";

export const T_HUMANGATE_REQUESTED = defineEventType({
  topic: "humangate.requested",
  description: "A human request was minted (approval/question/notification).",
  payload: z.object({ kind: z.string(), subjectKind: z.string() }),
});
export const T_HUMANGATE_RESOLVED = defineEventType({
  topic: "humangate.resolved",
  description: "A human resolved a request; resolution comment always present.",
  payload: z.object({ verdict: z.string() }),
});
export const T_HUMANGATE_SUPERSEDED = defineEventType({
  topic: "humangate.superseded",
  description: "A cascade invalidated a granted/pending request; original approvers notified.",
  payload: z.object({ causeEventId: ulidSchema.optional() }),
});

// SLA sweep outcomes (internal responders only — external chasing lives on WorkItem.followUp).
export const T_HUMANGATE_FOLLOW_UP = defineEventType({
  topic: "humangate.follow_up",
  description: "SLA sweep nudged the current assignee of a still-pending request.",
  payload: z.object({ followUpCount: z.number().int().positive() }),
});
export const T_HUMANGATE_ESCALATED = defineEventType({
  topic: "humangate.escalated",
  description: "SLA sweep reassigned a still-pending request to the next step on its escalation path.",
  payload: z.object({
    followUpCount: z.number().int().positive(),
    assignee: z.union([refSchema, z.string().min(1)]),
  }),
});
export const T_HUMANGATE_EXPIRED = defineEventType({
  topic: "humangate.expired",
  description: "SLA sweep expired a pending request after its escalation path was exhausted.",
  payload: z.object({ followUpCount: z.number().int().nonnegative() }),
});
