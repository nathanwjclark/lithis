import { z } from "zod";
import { ulidSchema } from "../ids";
import { defineEventType } from "../events";
import { trustLevelSchema } from "../origin";

export const T_BLOB_CREATED = defineEventType({
  topic: "context.blob.created",
  description: "Raw bytes landed in object storage.",
  payload: z.object({ mediaType: z.string(), sizeBytes: z.number().int(), trust: trustLevelSchema }),
});
export const T_DOC_CREATED = defineEventType({
  topic: "context.doc.created",
  description: "A doc record exists (quarantined by default). Path/type WatchRules may fire here.",
  payload: z.object({ docType: z.string(), connectorSlug: z.string().optional() }),
});
export const T_DOC_DISTILLED = defineEventType({
  topic: "context.doc.distilled",
  description: "Ingest-time distill wrote summary + entities + links. Entity-scoped WatchRules fire here.",
  payload: z.object({ entityIds: z.array(ulidSchema), linkIds: z.array(ulidSchema) }),
});
export const T_ENTITY_CREATED = defineEventType({
  topic: "context.entity.created",
  description: "A structured entity (person/company/project/...) was created.",
  payload: z.object({ entityType: z.string(), degree: z.number().optional() }),
});
export const T_LINK_CREATED = defineEventType({
  topic: "context.link.created",
  description: "A typed association was asserted (at ingest or by an agent in a session).",
  payload: z.object({ verb: z.string() }),
});
