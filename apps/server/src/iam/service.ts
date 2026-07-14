import { agentCharterSchema, newUlid, nowIso, principalSchema, tenantSchema } from "@lithis/core";
import type { AgentCharter, Principal, Tenant, Ulid } from "@lithis/core";
import { txSql } from "../db";
import type { Db } from "../db";
import type { EventSpine } from "../spine";
import type { IdentityService, NewPrincipal, NewTenant } from "./index";

/**
 * Postgres-backed identity: tenants, principals, and charter lookup. Creation
 * events ride the transactional outbox — the iam.* event commits with the row
 * or not at all.
 */

interface CharterRow {
  principal_id: string;
  tenant_id: string;
  role: string;
  prompt_ref: unknown;
  memory_blob_id: string;
  model_policy: unknown;
  budgets: unknown;
  wake: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Bun's SQL client returns jsonb columns as JSON text — parse before zod. */
function fromJsonb(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

export function createPgIdentityService(db: Db, spine: EventSpine): IdentityService {
  return {
    async createTenant(input: NewTenant): Promise<Tenant> {
      const id = newUlid();
      const at = nowIso();
      const tenant = tenantSchema.parse({ id, ...input, createdAt: at, updatedAt: at });
      await db.withTx(async (tx) => {
        await txSql(tx)`
          insert into iam.tenants (id, tenant_id, slug, name, status, created_at, updated_at)
          values (${id}, ${id}, ${tenant.slug}, ${tenant.name}, ${tenant.status}, ${at}, ${at})`;
        // Bootstrap has no caller identity yet — the tenant is its own actor.
        // Revisit when the policy layer lands (TODOS.md).
        await spine.append(tx, {
          tenantId: id,
          topic: "iam.tenant.created",
          subjectRefs: [{ kind: "tenant", id }],
          actor: { kind: "tenant", id },
          payload: { slug: tenant.slug },
        });
      });
      return tenant;
    },

    async createPrincipal(input: NewPrincipal): Promise<Principal> {
      const id = newUlid();
      const at = nowIso();
      const principal = principalSchema.parse({ id, ...input, createdAt: at, updatedAt: at });
      try {
        await db.withTx(async (tx) => {
          await txSql(tx)`
            insert into iam.principals
              (id, tenant_id, kind, slug, display_name, email, status, created_at, updated_at)
            values
              (${id}, ${principal.tenantId}, ${principal.kind}, ${principal.slug},
               ${principal.displayName}, ${principal.email ?? null}, ${principal.status},
               ${at}, ${at})`;
          await spine.append(tx, {
            tenantId: principal.tenantId,
            topic: "iam.principal.created",
            subjectRefs: [{ kind: "principal", id }],
            actor: { kind: "principal", id }, // self-registered at bootstrap
            payload: { kind: principal.kind, slug: principal.slug },
          });
        });
      } catch (err) {
        if (err instanceof Error && /principals_tenant_id_slug|duplicate key/.test(err.message)) {
          throw new Error(
            `principal slug '${principal.slug}' already exists in tenant ${principal.tenantId}`,
          );
        }
        throw err;
      }
      return principal;
    },

    async getCharter(principalId: Ulid): Promise<AgentCharter | null> {
      const rows: CharterRow[] = await db.sql`
        select * from iam.agent_charters where principal_id = ${principalId}`;
      const row = rows[0];
      if (row === undefined) return null;
      return agentCharterSchema.parse({
        principalId: row.principal_id,
        tenantId: row.tenant_id,
        role: row.role,
        promptRef: fromJsonb(row.prompt_ref),
        memoryBlobId: row.memory_blob_id,
        modelPolicy: fromJsonb(row.model_policy),
        budgets: fromJsonb(row.budgets),
        wake: fromJsonb(row.wake),
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
      });
    },
  };
}
