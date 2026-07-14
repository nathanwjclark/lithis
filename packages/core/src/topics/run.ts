import { z } from "zod";
import { costSchema } from "../common";
import { defineEventType } from "../events";

export const T_RUN_STARTED = defineEventType({
  topic: "run.started",
  description: "Agent run began inside a session.",
  payload: z.object({ model: z.string(), triggerCause: z.string() }),
});
export const T_RUN_FINISHED = defineEventType({
  topic: "run.finished",
  description: "Agent run ended (any terminal status); cost recorded.",
  payload: z.object({ status: z.string(), cost: costSchema }),
});
