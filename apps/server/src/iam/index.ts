import type {
  AgentCharter,
  Capability,
  PolicyDecision,
  Principal,
  PrincipalContext,
  Ref,
  Tenant,
  Ulid,
} from "@lithis/core";
import { stubService } from "@lithis/stubkit";
import type { Db } from "../db";
import type { EventSpine, Subscription } from "../spine";
import type { ActionIntentService } from "./actions";
import { createPgIdentityService } from "./service";

/**
 * iam — tenants, principals, agent charters, and ActionIntent batches (the
 * module owns iam.action_intents). Deliberately minimal otherwise: the
 * policy/permissioning layer (Grant, Mandate, PolicyEngine wiring) is DEFERRED
 * to TODOS.md — PolicyEngine ships as an unwired stub and is intentionally
 * NOT threaded through other modules yet.
 *
 * REAL as of P12-browser: actions.ts (propose a gated batch → per-item
 * verdicts from humangate.resolved → execute approved items with an Evidence
 * receipt each) and executor.ts (capability → connector.act).
 */

export type NewTenant = Omit<Tenant, "id" | "createdAt" | "updatedAt">;
export type NewPrincipal = Omit<Principal, "id" | "createdAt" | "updatedAt">;
/** Charter keys are the principal's — only the timestamps are service-assigned. */
export type NewAgentCharter = Omit<AgentCharter, "createdAt" | "updatedAt">;

/**
 * DEFERRED (see TODOS.md): callers do not depend on this yet. The shape lives
 * in @lithis/core so future wiring creates no module cycles.
 */
export interface PolicyEngine {
  check(
    p: PrincipalContext,
    capability: Capability,
    resource?: Ref,
    ctx?: unknown,
  ): Promise<PolicyDecision>;
}

export interface IdentityService {
  createTenant(input: NewTenant): Promise<Tenant>;
  createPrincipal(input: NewPrincipal): Promise<Principal>;
  /** Makes a principal a resident agent; emits iam.charter.created. One charter per principal. */
  createCharter(input: NewAgentCharter): Promise<AgentCharter>;
  /** Null for principals that are not resident agents. */
  getCharter(principalId: Ulid): Promise<AgentCharter | null>;
  /** Point lookup by id; null when absent. */
  getPrincipal(principalId: Ulid): Promise<Principal | null>;
  /** Tenant-scoped slug lookup (slugs are unique per tenant); null when absent. */
  getPrincipalBySlug(tenantId: Ulid, slug: string): Promise<Principal | null>;
  /** Every tenant (the sentinel boot sweep iterates these). */
  listTenants(): Promise<Tenant[]>;
}

const policyEngine = stubService<PolicyEngine>(
  "server.iam.policy",
  ["check"],
  "LITHIS-STUB: policy engine deferred (Grant/Mandate wiring lives in TODOS.md); nothing depends on it yet",
);

export function createPolicyEngine(): PolicyEngine {
  return policyEngine;
}

export function createIdentityService(db: Db, spine: EventSpine): IdentityService {
  return createPgIdentityService(db, spine);
}

export { ensureDevSeed, findDevSeed } from "./seed";

// ── ActionIntent batches (P12-browser) ──────────────────────────────────────

export {
  actionBatchItemSchema,
  actionBatchPayloadSchema,
  createActionIntentService,
} from "./actions";
export type {
  ActionBatchItem,
  ActionBatchPayload,
  ActionExecutionResult,
  ActionExecutor,
  ActionGate,
  ActionIntentDeps,
  ActionIntentService,
  BatchExecutionSummary,
  BatchResolution,
  NewActionIntent,
  ProposeBatchInput,
  ProposeBatchResult,
} from "./actions";
export { createConnectorActionExecutor, resolveCapability } from "./executor";
export type { ConnectorActionExecutorDeps } from "./executor";

/**
 * Wire the action-batch consumer onto the spine (called at boot wherever the
 * dispatcher runs). Per-item application is guarded on `status = 'proposed'`,
 * so at-least-once redelivery cannot double-apply a verdict or double-send an
 * action.
 */
export function attachActionIntents(
  spine: EventSpine,
  actions: ActionIntentService,
): Subscription {
  return spine.subscribe(
    "iam.action-batches",
    { topics: ["humangate.resolved"] },
    (e) => actions.handleResolved(e),
  );
}
