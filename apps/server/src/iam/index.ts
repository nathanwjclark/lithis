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
  /** Null for principals that are not resident agents. */
  getCharter(principalId: Ulid): Promise<AgentCharter | null>;
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
