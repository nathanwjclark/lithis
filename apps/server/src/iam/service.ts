import { agentCharterSchema, newUlid, nowIso, principalSchema, tenantSchema } from "@lithis/core";
import type { AgentCharter, Principal, Tenant, Ulid } from "@lithis/core";
import { txSql } from "../db";
import type { Db } from "../db";
import type { EventSpine } from "../spine";
import type { IdentityService, NewAgentCharter, NewPrincipal, NewTenant } from "./index";

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

interface PrincipalRow {
  id: string;
  tenant_id: string;
  kind: string;
  slug: string;
  display_name: string;
  email: string | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToPrincipal(row: PrincipalRow): Principal {
  return principalSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    slug: row.slug,
    displayName: row.display_name,
    ...(row.email !== null ? { email: row.email } : {}),
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
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

    async createCharter(input: NewAgentCharter): Promise<AgentCharter> {
      const at = nowIso();
      const charter = agentCharterSchema.parse({ ...input, createdAt: at, updatedAt: at });
      try {
        await db.withTx(async (tx) => {
          await txSql(tx)`
            insert into iam.agent_charters
              (principal_id, tenant_id, role, prompt_ref, memory_blob_id,
               model_policy, budgets, wake, created_at, updated_at)
            values
              (${charter.principalId}, ${charter.tenantId}, ${charter.role},
               ${JSON.stringify(charter.promptRef)}::text::jsonb, ${charter.memoryBlobId},
               ${JSON.stringify(charter.modelPolicy)}::text::jsonb,
               ${JSON.stringify(charter.budgets)}::text::jsonb,
               ${JSON.stringify(charter.wake)}::text::jsonb,
               ${at}, ${at})`;
          await spine.append(tx, {
            tenantId: charter.tenantId,
            topic: "iam.charter.created",
            subjectRefs: [{ kind: "principal", id: charter.principalId }, charter.promptRef],
            actor: { kind: "principal", id: charter.principalId }, // self-chartered at bootstrap
            payload: { memoryBlobId: charter.memoryBlobId },
          });
        });
      } catch (err) {
        if (err instanceof Error && /agent_charters_pkey|duplicate key/.test(err.message)) {
          throw new Error(`principal ${charter.principalId} already has an agent charter`);
        }
        throw err;
      }
      return charter;
    },

    async getPrincipal(principalId: Ulid): Promise<Principal | null> {
      const rows: PrincipalRow[] = await db.sql`
        select * from iam.principals where id = ${principalId}`;
      const row = rows[0];
      return row === undefined ? null : rowToPrincipal(row);
    },

    async getPrincipalBySlug(tenantId: Ulid, slug: string): Promise<Principal | null> {
      const rows: PrincipalRow[] = await db.sql`
        select * from iam.principals where tenant_id = ${tenantId} and slug = ${slug}`;
      const row = rows[0];
      return row === undefined ? null : rowToPrincipal(row);
    },

    async listTenants(): Promise<Tenant[]> {
      interface TenantRow {
        id: string;
        slug: string;
        name: string;
        status: string;
        created_at: Date | string;
        updated_at: Date | string;
      }
      const rows: TenantRow[] = await db.sql`
        select id, slug, name, status, created_at, updated_at from iam.tenants order by id`;
      return rows.map((row) =>
        tenantSchema.parse({
          id: row.id,
          slug: row.slug,
          name: row.name,
          status: row.status,
          createdAt: toIso(row.created_at),
          updatedAt: toIso(row.updated_at),
        }),
      );
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
