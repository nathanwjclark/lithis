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
import type { EventSpine } from "../spine";
import { createPgIdentityService } from "./service";

/**
 * iam — tenants, principals, agent charters. Deliberately minimal: the
 * policy/permissioning layer (Grant, Mandate, PolicyEngine wiring) is DEFERRED
 * to TODOS.md — PolicyEngine ships as an unwired stub and is intentionally
 * NOT threaded through other modules yet.
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

export { ensureDevSeed } from "./seed";
