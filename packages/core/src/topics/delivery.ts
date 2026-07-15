import { z } from "zod";
import { ulidSchema } from "../ids";
import { defineEventType } from "../events";

export const T_DELIVERY_SENT = defineEventType({
  topic: "delivery.sent",
  description: "A card/digest/nudge was delivered via a connector's act().",
  payload: z.object({
    channel: z.string(),
    kind: z.string(),
    /** Channel-specific address the card went to (slack channel id, email, ...). */
    target: z.string().optional(),
    /** Upstream anchor for the sent thing — for Slack, "channel:ts" (the thread anchor replies resolve against). */
    externalId: z.string().optional(),
    humanRequestId: ulidSchema.optional(),
    connectionId: ulidSchema.optional(),
  }),
});

export const T_DELIVERY_FAILED = defineEventType({
  topic: "delivery.failed",
  description:
    "A card/digest/nudge could not be delivered (no connection, connector rejection, transport error) — recorded honestly, never silently dropped.",
  payload: z.object({
    channel: z.string(),
    kind: z.string(),
    target: z.string().optional(),
    humanRequestId: ulidSchema.optional(),
    connectionId: ulidSchema.optional(),
    reason: z.string(),
  }),
});
