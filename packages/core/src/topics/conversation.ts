import { z } from "zod";
import { ulidSchema } from "../ids";
import { defineEventType } from "../events";

/** Welfare watchers ride this topic — every human↔agent message is visible. */
export const T_CONVERSATION_MESSAGE = defineEventType({
  topic: "conversation.message",
  description:
    "Any inbound/outbound human↔agent message (slack, portal chat, email reply), ingested as a quarantined doc.",
  payload: z.object({
    direction: z.enum(["inbound", "outbound"]),
    channel: z.enum(["slack", "teams", "email", "portal"]),
    docId: ulidSchema,
  }),
});
