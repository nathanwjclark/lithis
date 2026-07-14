import { z } from "zod";
import { capabilitySchema, costSchema, recordBase, slugSchema } from "./common";
import { cronSchema, isoDateTimeSchema, ulidSchema } from "./ids";
import { refSchema } from "./refs";

/**
 * Identity — deliberately minimal. Tenants, principals, and agent charters are
 * real; the policy/permissioning layer (Grant, Mandate, PolicyEngine wiring) is
 * DEFERRED and intentionally not referenced by other schemas (see TODOS.md).
 */

export const tenantSchema = z.object({
  id: ulidSchema,
  slug: slugSchema,
  name: z.string().min(1),
  status: z.enum(["active", "suspended"]),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Tenant = z.infer<typeof tenantSchema>;

export const PRINCIPAL_KINDS = ["human", "agent", "service"] as const;
export const principalSchema = z.object({
  ...recordBase,
  kind: z.enum(PRINCIPAL_KINDS),
  slug: slugSchema,
  displayName: z.string().min(1),
  email: z.string().email().optional(),
  status: z.enum(["active", "disabled"]),
});
export type Principal = z.infer<typeof principalSchema>;

/**
 * AgentCharter — what makes a principal a RESIDENT agent (openclaw-style):
 * a role prompt, a durable memory notebook, model/budget policy, and a wake
 * policy. The agent decides what to do on each wake; the host only delivers
 * wake reasons and enforces budgets.
 */
export const agentCharterSchema = z.object({
  principalId: ulidSchema,
  tenantId: ulidSchema,
  role: z.string().min(1),
  /** Prompt document ref (doc in the context store — versioned like everything else). */
  promptRef: refSchema,
  /** Durable agent notebook (blob) — read at every wake, appended by the agent. */
  memoryBlobId: ulidSchema,
  modelPolicy: z.object({
    plan: z.string().min(1),
    execute: z.string().min(1),
    index: z.string().min(1),
  }),
  budgets: z.object({
    usdPerRun: z.number().positive(),
    usdPerDay: z.number().positive(),
  }),
  wake: z.object({
    heartbeat: cronSchema.optional(),
    /** Spine topic selectors this agent wakes on. */
    onEvents: z.array(z.string()).optional(),
    onMessages: z.boolean(),
  }),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type AgentCharter = z.infer<typeof agentCharterSchema>;

/** Caller identity threaded through every service interface. */
export const principalContextSchema = z.object({
  tenantId: ulidSchema,
  principalId: ulidSchema,
  kind: z.enum(PRINCIPAL_KINDS),
});
export type PrincipalContext = z.infer<typeof principalContextSchema>;

/**
 * ActionIntent — a proposed externally-visible action (an email send, a
 * LinkedIn connect, an SoR write). Batches (shared batchId) let one
 * HumanRequest carry per-item verdicts: "approve 38 of 40, edit 2".
 */
export const ACTION_INTENT_STATUSES = [
  "proposed",
  "approved",
  "denied",
  "modified",
  "executing",
  "executed",
  "failed",
] as const;

export const actionIntentSchema = z.object({
  ...recordBase,
  batchId: ulidSchema.optional(),
  principalId: ulidSchema,
  capability: capabilitySchema,
  params: z.unknown(),
  /** The external counterpart (an Entity — a person, a regulator, a carrier). */
  counterpartRef: refSchema.optional(),
  status: z.enum(ACTION_INTENT_STATUSES),
  /** Receipt evidence once executed. */
  receiptRef: refSchema.optional(),
});
export type ActionIntent = z.infer<typeof actionIntentSchema>;

/**
 * PolicyDecision — the stub-level policy surface. The engine ships unwired
 * (LITHIS-STUB in apps/server/src/iam); the shape lives here so future wiring
 * does not create module cycles.
 */
export const policyDecisionSchema = z.discriminatedUnion("effect", [
  z.object({ effect: z.literal("allow") }),
  z.object({ effect: z.literal("deny"), reason: z.string() }),
  z.object({
    effect: z.literal("require_approval"),
    route: z.object({
      assignee: z.union([refSchema, z.string()]),
      slaHours: z.number().positive().optional(),
    }),
  }),
]);
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
