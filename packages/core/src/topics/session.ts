import { z } from "zod";
import { costSchema } from "../common";
import { defineEventType } from "../events";

export const T_SESSION_STARTED = defineEventType({
  topic: "session.started",
  description: "An agent/human session opened (loop wake, chat, run, workbench).",
  payload: z.object({ kind: z.enum(["loop", "chat", "run", "workbench"]) }),
});
export const T_SESSION_ENDED = defineEventType({
  topic: "session.ended",
  description: "Session closed; cost is final.",
  payload: z.object({ cost: costSchema, summary: z.string().optional() }),
});
