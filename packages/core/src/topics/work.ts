import { z } from "zod";
import { ulidSchema } from "../ids";
import { defineEventType } from "../events";

export const T_WORK_OPENED = defineEventType({
  topic: "work.item.opened",
  description: "A work item entered the graph.",
  payload: z.object({ kind: z.string(), processRunId: ulidSchema.optional() }),
});
export const T_WORK_STATUS = defineEventType({
  topic: "work.item.status_changed",
  description: "Work item state-machine transition.",
  payload: z.object({ from: z.string(), to: z.string(), attempt: z.number().int() }),
});
export const T_WORK_NOTE = defineEventType({
  topic: "work.note.added",
  description: "Append-only journal entry on a work item.",
  payload: z.object({ noteKind: z.enum(["status", "human", "system"]) }),
});
