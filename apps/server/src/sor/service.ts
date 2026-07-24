import { newUlid, nowIso, sorDescriptorSchema, sorTableSchema } from "@lithis/core";
import type {
  Origin,
  PrincipalContext,
  Ref,
  SorDescriptor,
  SorTable,
  Ulid,
} from "@lithis/core";
import { z } from "zod";
import type { ContextStore } from "../context";
import { txSql } from "../db";
import type { Db, DbTx } from "../db";
import type { HumanGate, HumanRequestId } from "../humangate";
import type { EventSpine } from "../spine";
import {
  RESERVED_ENTITY_REF_COLUMN,
  RESERVED_ORIGIN_COLUMN,
  RESERVED_PK_COLUMN,
  quoteIdent,
  renderMigration,
  sorSchemaName,
  validateTables,
} from "./ddl";
import type { ScopedTable, SorDescriptorDraft, SorRow, SorRuntime } from "./index";

/**
 * The Postgres SorRuntime: descriptors in → real per-tenant SQL schemas out,
 * behind an approval gate.
 *
 * Lifecycle (docs/concepts/sor.md):
 *   propose(draft) → diff vs the APPLIED tables → render DDL → store it as a
 *   blob → HumanRequest{sor_migration} carrying that DDL → sor.migration.proposed
 *   apply(id)      → refuse unless the request is approved → run the DDL in ONE
 *                    transaction → stamp appliedAt into the descriptor's own
 *                    migrations array → sor.migration.applied
 *
 * Two invariants this file exists to hold:
 *   - v1 is ADDITIVE ONLY. A destructive diff is rejected loudly (ddl.ts), never
 *     partially applied.
 *   - No raw SQL surface. table() hands back a handle scoped to the caller's
 *     tenant schema whose every identifier came from the APPLIED descriptor and
 *     whose every value is a bound parameter.
 */

export class SorDescriptorNotFoundError extends Error {
  constructor(id: string) {
    super(`SoR descriptor ${id} not found`);
    this.name = "SorDescriptorNotFoundError";
  }
}

export class SorNotApprovedError extends Error {
  constructor(slug: string, version: number, state: string) {
    super(
      `SoR '${slug}' migration v${version} cannot apply: its sor_migration request is '${state}', ` +
        `not 'approved' — schema changes to a live system-of-record are never applied unreviewed`,
    );
    this.name = "SorNotApprovedError";
  }
}

export class SorProposalPendingError extends Error {
  constructor(slug: string, version: number, requestId: string) {
    super(
      `SoR '${slug}' already has migration v${version} awaiting approval (request ${requestId}) — ` +
        `resolve it before proposing another change`,
    );
    this.name = "SorProposalPendingError";
  }
}

export class SorSchemaNotAppliedError extends Error {
  constructor(slug: string) {
    super(
      `SoR '${slug}' has no applied migration yet — its tables do not exist. ` +
        `propose() then apply() the descriptor before reading or writing rows.`,
    );
    this.name = "SorSchemaNotAppliedError";
  }
}

export class SorColumnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SorColumnError";
  }
}

/** The pinned payload for HumanRequest{subjectKind:'sor_migration'}. */
export const sorMigrationPayloadSchema = z.object({
  sorSlug: z.string().min(1),
  displayName: z.string().min(1),
  version: z.number().int().positive(),
  /** The Postgres schema the DDL targets. */
  schema: z.string().min(1),
  /** Plain-language change list an approver reads first. */
  changes: z.array(z.string()),
  /** The EXACT SQL that will run — this is what is being approved. */
  ddl: z.string().min(1),
  ddlBlobId: z.string().min(1),
});
export type SorMigrationPayload = z.infer<typeof sorMigrationPayloadSchema>;

function fromJsonb(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

interface DescriptorRow {
  id: string;
  tenant_id: string;
  slug: string;
  display_name: string;
  version: number;
  tables: unknown;
  ddl_blob_id: string | null;
  migrations: unknown;
  applied_tables: unknown;
  applied_version: number | null;
  schema_name: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/** What the DB row says, split into the DECLARED descriptor + the APPLIED schema. */
export interface SorSystemState {
  descriptor: SorDescriptor;
  /** Tables that actually exist in Postgres (empty until the first apply). */
  appliedTables: SorTable[];
  appliedVersion?: number;
  schemaName: string;
}

function rowToState(row: DescriptorRow): SorSystemState {
  const descriptor = sorDescriptorSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    slug: row.slug,
    displayName: row.display_name,
    version: row.version,
    tables: fromJsonb(row.tables),
    ...(row.ddl_blob_id !== null ? { ddlBlobId: row.ddl_blob_id } : {}),
    migrations: fromJsonb(row.migrations),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
  const appliedRaw = fromJsonb(row.applied_tables);
  return {
    descriptor,
    appliedTables: appliedRaw === null || appliedRaw === undefined ? [] : sorTableSchema.array().parse(appliedRaw),
    ...(row.applied_version !== null ? { appliedVersion: row.applied_version } : {}),
    schemaName: row.schema_name ?? sorSchemaName(row.tenant_id, row.slug),
  };
}

/** The newest migration entry that has not been applied yet, if any. */
function pendingMigration(descriptor: SorDescriptor): SorDescriptor["migrations"][number] | undefined {
  return [...descriptor.migrations]
    .filter((m) => m.appliedAt === undefined)
    .sort((a, b) => b.version - a.version)[0];
}

// ── value binding for the scoped table handle ───────────────────────────────

const JS_TYPE_FOR_COLUMN: Record<SorTable["columns"][number]["type"], string> = {
  text: "string",
  integer: "number",
  numeric: "number",
  boolean: "boolean",
  date: "string",
  timestamptz: "string",
  jsonb: "object",
};

/**
 * Coerce + type-check one user value for its declared column. Values are ALWAYS
 * bound parameters — nothing here is interpolated into SQL text.
 */
function bindValue(
  table: SorTable,
  column: SorTable["columns"][number],
  value: unknown,
): { cast: string; param: unknown } {
  if (value === null || value === undefined) {
    if (!column.nullable) {
      throw new SorColumnError(
        `${table.name}.${column.name} is declared NOT NULL — null is not an acceptable value`,
      );
    }
    return { cast: "", param: null };
  }
  if (column.type === "jsonb") {
    return { cast: "::jsonb", param: JSON.stringify(value) };
  }
  const expected = JS_TYPE_FOR_COLUMN[column.type];
  const actual = Array.isArray(value) ? "array" : typeof value;
  if (column.type === "integer" && (actual !== "number" || !Number.isInteger(value))) {
    throw new SorColumnError(`${table.name}.${column.name} expects an integer, got ${JSON.stringify(value)}`);
  }
  if (column.type === "numeric" && actual !== "number" && actual !== "string") {
    throw new SorColumnError(`${table.name}.${column.name} expects a number, got ${actual}`);
  }
  if (column.type !== "integer" && column.type !== "numeric" && actual !== expected) {
    throw new SorColumnError(
      `${table.name}.${column.name} is ${column.type} and expects a ${expected}, got ${actual}`,
    );
  }
  const cast =
    column.type === "date" ? "::date" : column.type === "timestamptz" ? "::timestamptz" : "";
  return { cast, param: value };
}

/**
 * `col = NULL` matches NOTHING in SQL. A caller filtering on null almost
 * certainly means IS NULL, so accepting it would return a silently-empty
 * result set — refuse instead until an explicit is-null filter exists.
 */
function assertFilterable(table: SorTable, name: string, value: unknown): void {
  if (value === null || value === undefined) {
    throw new SorColumnError(
      `filter on ${table.name}.${name} is null — 'col = NULL' matches no rows in SQL, and an ` +
        `is-null filter is not supported yet; filter on a non-null column instead`,
    );
  }
}

function findColumn(table: SorTable, name: string): SorTable["columns"][number] {
  const column = table.columns.find((c) => c.name === name);
  if (column === undefined) {
    throw new SorColumnError(
      `unknown column '${name}' on SoR table '${table.name}' — declared columns: ${table.columns
        .map((c) => c.name)
        .join(", ")}`,
    );
  }
  return column;
}

export interface SorRuntimeDeps {
  db: Db;
  spine: EventSpine;
  humanGate: HumanGate;
  /** Rendered DDL is stored as a blob so the approval card cites immutable bytes. */
  contextStore: ContextStore;
}

export function createPgSorRuntime(deps: SorRuntimeDeps): SorRuntime {
  const { db, spine, humanGate, contextStore } = deps;

  async function loadById(id: Ulid, tenantId: Ulid): Promise<SorSystemState> {
    const rows: DescriptorRow[] = await db.sql`
      select * from sor.sor_descriptors where id = ${id} and tenant_id = ${tenantId}`;
    if (rows[0] === undefined) throw new SorDescriptorNotFoundError(id);
    return rowToState(rows[0]);
  }

  async function loadBySlug(tenantId: Ulid, slug: string): Promise<SorSystemState | undefined> {
    const rows: DescriptorRow[] = await db.sql`
      select * from sor.sor_descriptors where tenant_id = ${tenantId} and slug = ${slug}`;
    return rows[0] === undefined ? undefined : rowToState(rows[0]);
  }

  /** The applied table definition backing a scoped handle. */
  async function appliedTable(
    tenantId: Ulid,
    system: string,
    name: string,
  ): Promise<{ state: SorSystemState; table: SorTable }> {
    const state = await loadBySlug(tenantId, system);
    if (state === undefined) {
      throw new SorDescriptorNotFoundError(`${system} (tenant ${tenantId})`);
    }
    if (state.appliedTables.length === 0) throw new SorSchemaNotAppliedError(system);
    const table = state.appliedTables.find((t) => t.name === name);
    if (table === undefined) {
      throw new SorColumnError(
        `SoR '${system}' has no APPLIED table '${name}' — applied tables: ${state.appliedTables
          .map((t) => t.name)
          .join(", ")}`,
      );
    }
    return { state, table };
  }

  function scopedTable<T>(system: string, name: string, p: PrincipalContext): ScopedTable<T> {
    async function resolve(): Promise<{ state: SorSystemState; table: SorTable; qualified: string }> {
      const { state, table } = await appliedTable(p.tenantId, system, name);
      const qualified = `${quoteIdent(state.schemaName, "schema name")}.${quoteIdent(table.name, "table name")}`;
      return { state, table, qualified };
    }

    async function emit(
      tx: DbTx,
      state: SorSystemState,
      op: "insert" | "update",
      rows: number,
      rowId?: Ulid,
    ): Promise<void> {
      await spine.append(tx, {
        tenantId: p.tenantId,
        topic: "sor.row.written",
        subjectRefs: [
          { kind: "sor_schema", id: state.descriptor.id },
          ...(rowId !== undefined ? [{ kind: "sor_row", id: rowId } as const] : []),
        ],
        actor: { kind: "principal", id: p.principalId },
        payload: { sorSlug: system, table: name, op, rows },
      });
    }

    return {
      async insert(row, opts) {
        const { state, table, qualified } = await resolve();
        const origin: Origin = {
          by: { kind: "principal", id: p.principalId },
          method: opts?.origin?.method ?? (p.kind === "human" ? "human" : "code"),
          trust: opts?.origin?.trust ?? "internal",
          ...(opts?.origin?.sessionId !== undefined ? { sessionId: opts.origin.sessionId } : {}),
          at: nowIso(),
        };
        if (opts?.entityRef !== undefined && !table.columns.some((c) => c.entityBinding !== undefined)) {
          throw new SorColumnError(
            `SoR table '${table.name}' declares no entityBinding column — an _entity_ref stamp would be meaningless here`,
          );
        }

        const record = row as Record<string, unknown>;
        for (const key of Object.keys(record)) {
          if (key.startsWith("_")) {
            throw new SorColumnError(
              `'${key}' is a reserved lithis column — _origin and _entity_ref are stamped by the runtime, not supplied by callers`,
            );
          }
          findColumn(table, key);
        }
        for (const column of table.columns) {
          if (!column.nullable && record[column.name] === undefined) {
            throw new SorColumnError(
              `${table.name}.${column.name} is NOT NULL but no value was supplied`,
            );
          }
        }

        const id = newUlid();
        const columns = [
          quoteIdent(RESERVED_PK_COLUMN, "reserved column", { allowReserved: true }),
          quoteIdent(RESERVED_ORIGIN_COLUMN, "reserved column", { allowReserved: true }),
          quoteIdent(RESERVED_ENTITY_REF_COLUMN, "reserved column", { allowReserved: true }),
        ];
        const params: unknown[] = [id, JSON.stringify(origin), opts?.entityRef === undefined ? null : JSON.stringify(opts.entityRef)];
        const values = ["$1", "$2::jsonb", "$3::jsonb"];
        for (const [key, value] of Object.entries(record)) {
          const column = findColumn(table, key);
          const bound = bindValue(table, column, value);
          columns.push(quoteIdent(column.name, `column name (${table.name})`));
          params.push(bound.param);
          values.push(`$${params.length}${bound.cast}`);
        }
        const sql = `insert into ${qualified} (${columns.join(", ")}) values (${values.join(", ")})`;

        await db.withTx(async (tx) => {
          await txSql(tx).unsafe(sql, params);
          await emit(tx, state, "insert", 1, id);
        });
        return {
          ...(row as object),
          _id: id,
          _origin: origin,
          ...(opts?.entityRef !== undefined ? { _entityRef: opts.entityRef } : {}),
        } as SorRow<T>;
      },

      async update(where, patch) {
        const { state, table, qualified } = await resolve();
        const patchEntries = Object.entries(patch as Record<string, unknown>);
        if (patchEntries.length === 0) {
          throw new SorColumnError(`update on '${table.name}' with an empty patch changes nothing`);
        }
        const whereEntries = Object.entries(where as Record<string, unknown>);
        if (whereEntries.length === 0) {
          throw new SorColumnError(
            `update on '${table.name}' with an empty where clause would rewrite every row — refused`,
          );
        }
        const params: unknown[] = [];
        const sets = patchEntries.map(([key, value]) => {
          const column = findColumn(table, key);
          const bound = bindValue(table, column, value);
          params.push(bound.param);
          return `${quoteIdent(column.name, `column name (${table.name})`)} = $${params.length}${bound.cast}`;
        });
        const filters = whereEntries.map(([key, value]) => {
          const column = findColumn(table, key);
          assertFilterable(table, key, value);
          const bound = bindValue(table, column, value);
          params.push(bound.param);
          return `${quoteIdent(column.name, `column name (${table.name})`)} = $${params.length}${bound.cast}`;
        });
        const sql = `update ${qualified} set ${sets.join(", ")} where ${filters.join(" and ")} returning ${quoteIdent(RESERVED_PK_COLUMN, "reserved column", { allowReserved: true })}`;
        return await db.withTx(async (tx) => {
          const rows: unknown[] = await txSql(tx).unsafe(sql, params);
          await emit(tx, state, "update", rows.length);
          return rows.length;
        });
      },

      async select(where) {
        const { table, qualified } = await resolve();
        const params: unknown[] = [];
        const filters = Object.entries((where ?? {}) as Record<string, unknown>).map(([key, value]) => {
          const column = findColumn(table, key);
          assertFilterable(table, key, value);
          const bound = bindValue(table, column, value);
          params.push(bound.param);
          return `${quoteIdent(column.name, `column name (${table.name})`)} = $${params.length}${bound.cast}`;
        });
        const sql =
          `select * from ${qualified}` +
          (filters.length > 0 ? ` where ${filters.join(" and ")}` : "") +
          ` order by ${quoteIdent(RESERVED_PK_COLUMN, "reserved column", { allowReserved: true })}`;
        const rows: Record<string, unknown>[] = await db.sql.unsafe(sql, params);
        return rows.map((raw) => {
          const out: Record<string, unknown> = {};
          for (const column of table.columns) {
            // Bun's SQL client hands jsonb back as JSON TEXT — parse it so a
            // round-tripped object is an object, not a string that looks like one.
            // `numeric` deliberately stays a string: Postgres numerics can exceed
            // IEEE-754 precision and silently lossy coercion is the enemy here.
            out[column.name] = column.type === "jsonb" ? fromJsonb(raw[column.name]) : raw[column.name];
          }
          out["_id"] = raw[RESERVED_PK_COLUMN];
          out["_origin"] = fromJsonb(raw[RESERVED_ORIGIN_COLUMN]);
          const entityRef = fromJsonb(raw[RESERVED_ENTITY_REF_COLUMN]);
          if (entityRef !== null && entityRef !== undefined) out["_entityRef"] = entityRef;
          return out as SorRow<T>;
        });
      },
    };
  }

  return {
    async list(tenantId: Ulid): Promise<SorSystemState[]> {
      const rows: DescriptorRow[] = await db.sql`
        select * from sor.sor_descriptors where tenant_id = ${tenantId} order by slug`;
      return rows.map(rowToState);
    },

    async get(id: Ulid, tenantId: Ulid): Promise<SorSystemState | undefined> {
      const rows: DescriptorRow[] = await db.sql`
        select * from sor.sor_descriptors where id = ${id} and tenant_id = ${tenantId}`;
      return rows[0] === undefined ? undefined : rowToState(rows[0]);
    },

    async getBySlug(tenantId: Ulid, slug: string): Promise<SorSystemState | undefined> {
      return await loadBySlug(tenantId, slug);
    },

    async propose(draft: SorDescriptorDraft, p: PrincipalContext): Promise<HumanRequestId> {
      if (draft.tenantId !== p.tenantId) {
        throw new Error(
          `SoR proposal tenant ${draft.tenantId} does not match the caller's tenant ${p.tenantId}`,
        );
      }
      const tables = validateTables(draft.tables);
      const schemaName = sorSchemaName(draft.tenantId, draft.slug);
      const existing = await loadBySlug(draft.tenantId, draft.slug);

      if (existing !== undefined) {
        const pending = pendingMigration(existing.descriptor);
        if (pending !== undefined) {
          const request = await humanGate.get(pending.approvalRequestId, draft.tenantId);
          if (request === undefined || request.state === "pending") {
            throw new SorProposalPendingError(draft.slug, pending.version, pending.approvalRequestId);
          }
        }
      }

      const appliedVersion = existing?.appliedVersion ?? 0;
      const declaredVersion = existing?.descriptor.version ?? 0;
      const nextVersion = Math.max(appliedVersion, declaredVersion) + 1;
      if (draft.version !== nextVersion) {
        throw new Error(
          `SoR '${draft.slug}': proposed version ${draft.version} is not the next version — ` +
            `expected ${nextVersion} (applied v${appliedVersion || "none"}, declared v${declaredVersion || "none"})`,
        );
      }

      // Throws SorDestructiveMigrationError when the diff is not additive.
      const migration = renderMigration(
        draft.tenantId,
        draft.slug,
        nextVersion,
        existing?.appliedTables ?? [],
        tables,
      );

      const ddlBlob = await contextStore.putBlob(
        {
          tenantId: draft.tenantId,
          mediaType: "application/sql",
          origin: {
            by: { kind: "principal", id: p.principalId },
            method: p.kind === "human" ? "human" : "code",
            trust: "internal",
            at: nowIso(),
          },
        },
        new TextEncoder().encode(migration.sql),
      );

      const descriptorId = existing?.descriptor.id ?? newUlid();
      const payload: SorMigrationPayload = sorMigrationPayloadSchema.parse({
        sorSlug: draft.slug,
        displayName: draft.displayName,
        version: nextVersion,
        schema: schemaName,
        changes: migration.summary,
        ddl: migration.sql,
        ddlBlobId: ddlBlob.id,
      });
      // The gate opens BEFORE the descriptor write because the migration audit
      // entry requires the approvalRequestId (core sorMigrationSchema).
      const request = await humanGate.request({
        tenantId: draft.tenantId,
        kind: "approval",
        subjectKind: "sor_migration",
        subjectRef: { kind: "sor_schema", id: descriptorId },
        payload,
        evidenceIds: [],
        summary:
          `Apply schema migration v${nextVersion} to system-of-record '${draft.slug}' ` +
          `(${draft.displayName}) in Postgres schema ${schemaName}? Changes: ` +
          `${migration.summary.join("; ")}. The exact DDL is in the payload (blob ${ddlBlob.id}).`,
        options: ["approve", "deny"],
        routing: {
          assignee: "tenant-admin",
          channelPrefs: ["portal"],
          escalationPath: [],
          followUpCount: 0,
        },
        requestedBy: { kind: "principal", id: p.principalId },
      });

      const at = nowIso();
      const migrations = [
        ...(existing?.descriptor.migrations ?? []),
        {
          version: nextVersion,
          sqlBlobId: ddlBlob.id,
          appliedBy: p.kind === "human" ? ("human" as const) : ("agent" as const),
          approvalRequestId: request.id,
        },
      ];

      await db.withTx(async (tx) => {
        const sql = txSql(tx);
        if (existing === undefined) {
          await sql`
            insert into sor.sor_descriptors
              (id, tenant_id, slug, display_name, version, tables, ddl_blob_id, migrations,
               applied_tables, applied_version, schema_name, created_at, updated_at)
            values
              (${descriptorId}, ${draft.tenantId}, ${draft.slug}, ${draft.displayName},
               ${nextVersion}, ${JSON.stringify(tables)}::text::jsonb, ${ddlBlob.id},
               ${JSON.stringify(migrations)}::text::jsonb, null, null, ${schemaName}, ${at}, ${at})`;
        } else {
          await sql`
            update sor.sor_descriptors
            set display_name = ${draft.displayName}, version = ${nextVersion},
                tables = ${JSON.stringify(tables)}::text::jsonb, ddl_blob_id = ${ddlBlob.id},
                migrations = ${JSON.stringify(migrations)}::text::jsonb,
                schema_name = ${schemaName}, updated_at = ${at}
            where id = ${descriptorId} and tenant_id = ${draft.tenantId}`;
        }
        await spine.append(tx, {
          tenantId: draft.tenantId,
          topic: "sor.migration.proposed",
          subjectRefs: [
            { kind: "sor_schema", id: descriptorId },
            { kind: "human_request", id: request.id },
          ],
          actor: { kind: "principal", id: p.principalId },
          payload: { sorSlug: draft.slug, version: nextVersion },
        });
      });

      return request.id;
    },

    async apply(descriptorId: Ulid, p: PrincipalContext): Promise<void> {
      const state = await loadById(descriptorId, p.tenantId);
      const pending = pendingMigration(state.descriptor);
      if (pending === undefined) {
        throw new Error(
          `SoR '${state.descriptor.slug}' has no pending migration — every declared version is already applied`,
        );
      }
      const request = await humanGate.get(pending.approvalRequestId, p.tenantId);
      if (request === undefined || request.state !== "approved") {
        throw new SorNotApprovedError(
          state.descriptor.slug,
          pending.version,
          request?.state ?? "missing",
        );
      }

      const ddl = new TextDecoder().decode(
        await contextStore.readBlob(p.tenantId, pending.sqlBlobId),
      );
      const at = nowIso();
      const appliedBy = p.kind === "human" ? ("human" as const) : ("agent" as const);
      const migrations = state.descriptor.migrations.map((m) =>
        m.version === pending.version ? { ...m, appliedBy, appliedAt: at } : m,
      );

      await db.withTx(async (tx) => {
        const sql = txSql(tx);
        // The DDL runs in the SAME transaction as the audit write: a failure
        // rolls back both, so the descriptor can never claim an un-applied schema.
        await sql.unsafe(ddl);
        await sql`
          update sor.sor_descriptors
          set applied_tables = ${JSON.stringify(state.descriptor.tables)}::text::jsonb,
              applied_version = ${pending.version},
              migrations = ${JSON.stringify(migrations)}::text::jsonb,
              schema_name = ${state.schemaName}, updated_at = ${at}
          where id = ${descriptorId} and tenant_id = ${p.tenantId}`;
        await spine.append(tx, {
          tenantId: p.tenantId,
          topic: "sor.migration.applied",
          subjectRefs: [
            { kind: "sor_schema", id: descriptorId },
            { kind: "human_request", id: pending.approvalRequestId },
          ],
          actor: { kind: "principal", id: p.principalId },
          payload: { sorSlug: state.descriptor.slug, version: pending.version, appliedBy },
        });
      });
    },

    table<T>(system: string, name: string, p: PrincipalContext): ScopedTable<T> {
      return scopedTable<T>(system, name, p);
    },
  };
}

