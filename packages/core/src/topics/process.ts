import { z } from "zod";
import { defineEventType } from "../events";

export const T_PROCESS_INSTANTIATED = defineEventType({
  topic: "process.run.instantiated",
  description: "A process template was instantiated (nodes minted as work items, WatchRules bound).",
  payload: z.object({ templateSlug: z.string().optional(), nodeCount: z.number().int() }),
});
export const T_CASCADE_PLANNED = defineEventType({
  topic: "process.cascade.planned",
  description: "The Invalidator planned a rerun cascade (may itself gate on width).",
  payload: z.object({ dirtyNodeKey: z.string(), width: z.number().int(), autoExecute: z.boolean() }),
});
export const T_CASCADE_EXECUTED = defineEventType({
  topic: "process.cascade.executed",
  description: "Cascade applied: results superseded, dependents staled, leases revoked.",
  payload: z.object({ dirtyNodeKey: z.string(), staleCount: z.number().int() }),
});
