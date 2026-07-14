import { z } from "zod";
import { defineEventType } from "../events";

export const T_DELIVERY_SENT = defineEventType({
  topic: "delivery.sent",
  description: "A card/digest/nudge was delivered via a connector's act().",
  payload: z.object({ channel: z.string(), kind: z.string() }),
});
