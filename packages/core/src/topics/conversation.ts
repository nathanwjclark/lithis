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
    /** Connection the message arrived through / left by, when channel-transported. */
    connectionId: ulidSchema.optional(),
    /** Channel-native id of THIS message — for Slack, "channel:ts". */
    externalId: z.string().optional(),
    /** Channel-native id of the thread parent, when the message is a reply — for
     * Slack, "channel:thread_ts"; matches the delivery record's externalId anchor. */
    threadExternalId: z.string().optional(),
    /** Channel-native author id (Slack user id, email address, ...). */
    authorExternalId: z.string().optional(),
    /** Message text, inline so subscribers (resolve mapping, welfare watchers)
     * need no doc fetch. The quarantined doc remains the record of truth. */
    text: z.string().optional(),
  }),
});
