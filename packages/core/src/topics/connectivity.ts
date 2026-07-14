import { z } from "zod";
import { defineEventType } from "../events";
import { isoDateTimeSchema, ulidSchema } from "../ids";

export const T_CONNECTION_REGISTERED = defineEventType({
  topic: "connection.registered",
  description: "A connector instance was registered in the connection registry.",
  payload: z.object({ connectorSlug: z.string(), displayName: z.string() }),
});
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
export const T_FEED_RECOVERED = defineEventType({
  topic: "feed.expectation.recovered",
  description: "A previously-missed feed arrived again (grace window reset).",
  payload: z.object({ key: z.string(), missedCount: z.number().int() }),
});
export const T_CREDENTIAL_CREATED = defineEventType({
  topic: "custody.credential.created",
  description: "A credential record was created (metadata only — never secret material).",
  payload: z.object({ kind: z.string(), custodyBackendRef: z.string() }),
});
export const T_CREDENTIAL_BROKERED = defineEventType({
  topic: "custody.credential.brokered",
  description: "Custody minted a short-lived brokered handle for a credential.",
  payload: z.object({
    credentialId: ulidSchema,
    kind: z.string(),
    expiresAt: isoDateTimeSchema,
  }),
});
