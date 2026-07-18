import { z } from "zod";
import { slugSchema } from "../common";
import { defineEventType } from "../events";
import { PRINCIPAL_KINDS } from "../iam";
import { ulidSchema } from "../ids";

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
export const T_CHARTER_CREATED = defineEventType({
  topic: "iam.charter.created",
  description:
    "An AgentCharter was created — the principal (first subject ref) is now a resident agent; " +
    "the charter prompt doc rides as the second subject ref.",
  payload: z.object({ memoryBlobId: ulidSchema }),
});
