import { z } from "zod";
import { defineEventType } from "../events";
import { ulidSchema } from "../ids";

export const T_PROCESS_TEMPLATE_SAVED = defineEventType({
  topic: "process.template.saved",
  description: "An authored process template (a version) was stored.",
  payload: z.object({ slug: z.string(), version: z.string(), mode: z.string() }),
});
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
export const T_CASCADE_DISCARDED = defineEventType({
  topic: "process.cascade.discarded",
  description: "A gated cascade plan was denied/expired by its reviewer — nothing reruns.",
  payload: z.object({ dirtyNodeKey: z.string(), humanRequestId: ulidSchema }),
});
export const T_GRAPH_CHANGE_PROPOSED = defineEventType({
  topic: "process.graph.change_proposed",
  description: "An agent proposed an instance-graph change (adaptive/dynamic); gated as a HumanRequest.",
  payload: z.object({
    humanRequestId: ulidSchema,
    addNodeCount: z.number().int(),
    skipNodeKeys: z.array(z.string()),
  }),
});
export const T_GRAPH_CHANGED = defineEventType({
  topic: "process.graph.changed",
  description: "An approved instance-graph change was applied; graphRevision bumped.",
  payload: z.object({ graphRevision: z.number().int(), addedNodeKeys: z.array(z.string()), cancelledNodeKeys: z.array(z.string()) }),
});
