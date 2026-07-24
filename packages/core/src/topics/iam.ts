import { z } from "zod";
import { capabilitySchema, slugSchema } from "../common";
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

// ── ActionIntent batches (P12-browser) ──────────────────────────────────────
// Externally-visible actions are proposed as a batch, reviewed as ONE
// HumanRequest{action_batch} with per-item verdicts, and executed item by item
// with an Evidence receipt each. Nothing leaves the building unapproved.

export const T_ACTION_BATCH_PROPOSED = defineEventType({
  topic: "iam.action_batch.proposed",
  description:
    "A batch of ActionIntents was proposed and gated behind one HumanRequest{action_batch} " +
    "(subjects: the batch, then the human request).",
  payload: z.object({
    batchId: ulidSchema,
    itemCount: z.number().int().positive(),
    capabilities: z.array(capabilitySchema),
  }),
});

export const T_ACTION_BATCH_RESOLVED = defineEventType({
  topic: "iam.action_batch.resolved",
  description:
    "A human resolved an action batch; per-item verdicts were applied to the intents.",
  payload: z.object({
    batchId: ulidSchema,
    approved: z.number().int().nonnegative(),
    denied: z.number().int().nonnegative(),
    modified: z.number().int().nonnegative(),
  }),
});

export const T_ACTION_INTENT_EXECUTED = defineEventType({
  topic: "iam.action_intent.executed",
  description: "An approved ActionIntent executed; its Evidence receipt rides the second subject ref.",
  payload: z.object({
    batchId: ulidSchema.optional(),
    capability: capabilitySchema,
    externalId: z.string().optional(),
  }),
});

export const T_ACTION_INTENT_FAILED = defineEventType({
  topic: "iam.action_intent.failed",
  description: "An approved ActionIntent failed to execute; the failure receipt rides as Evidence.",
  payload: z.object({
    batchId: ulidSchema.optional(),
    capability: capabilitySchema,
    error: z.string(),
  }),
});
