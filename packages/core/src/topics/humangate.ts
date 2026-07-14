import { z } from "zod";
import { ulidSchema } from "../ids";
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
