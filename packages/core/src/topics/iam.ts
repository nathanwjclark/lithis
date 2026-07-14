import { z } from "zod";
import { slugSchema } from "../common";
import { defineEventType } from "../events";
import { PRINCIPAL_KINDS } from "../iam";

export const T_TENANT_CREATED = defineEventType({
  topic: "iam.tenant.created",
  description: "A tenant was created (self-referential actor — bootstrap has no caller identity).",
  payload: z.object({ slug: slugSchema }),
});
export const T_PRINCIPAL_CREATED = defineEventType({
  topic: "iam.principal.created",
  description: "A principal (human/agent/service) was created in a tenant.",
  payload: z.object({ kind: z.enum(PRINCIPAL_KINDS), slug: slugSchema }),
});
