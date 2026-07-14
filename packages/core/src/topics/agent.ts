import { z } from "zod";
import { defineEventType } from "../events";

export const T_AGENT_WOKE = defineEventType({
  topic: "agent.woke",
  description: "A resident agent woke (heartbeat/message/event/work_available/manual).",
  payload: z.object({ reason: z.enum(["heartbeat", "message", "event", "work_available", "manual"]) }),
});
export const T_AGENT_SLEPT = defineEventType({
  topic: "agent.slept",
  description: "A resident agent closed its session and scheduled its own next wake.",
  payload: z.object({ nextWakeAt: z.string().optional() }),
});
