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
export const T_AGENT_TOOL_CALLED = defineEventType({
  topic: "agent.tool_called",
  description: "The executor dispatched one tool call inside a run (the ToolBroker audit trail).",
  payload: z.object({ tool: z.string().min(1), isError: z.boolean() }),
});
