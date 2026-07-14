import { z } from "zod";
import { defineEventType } from "../events";

export const T_SYNC_COMPLETED = defineEventType({
  topic: "connector.sync.completed",
  description: "A connector feed sync finished.",
  payload: z.object({ feed: z.string(), newDocs: z.number().int(), cursor: z.string().optional() }),
});
export const T_CONNECTION_HEALTH = defineEventType({
  topic: "connection.health.changed",
  description: "Connection health transitioned (healthy/degraded/expired/disabled).",
  payload: z.object({ from: z.string(), to: z.string(), error: z.string().optional() }),
});
export const T_FEED_MISSED = defineEventType({
  topic: "feed.expectation.missed",
  description: "An expected feed did not arrive within its grace window.",
  payload: z.object({ key: z.string(), missedCount: z.number().int() }),
});
