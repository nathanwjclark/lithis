import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUlid, nowIso } from "@lithis/core";
import type { PrincipalContext, SorTable } from "@lithis/core";
import { amsSorDescriptor } from "@lithis/pack-insurance-brokerage";
import { createContextStore, createLocalBlobStorage } from "../../src/context";
import type { ContextStore } from "../../src/context";
import { createHumanGate } from "../../src/humangate";
import type { HumanGate } from "../../src/humangate";
import {
  SorColumnError,
  SorDestructiveMigrationError,
  SorIdentifierError,
  SorNotApprovedError,
  SorProposalPendingError,
  createSorRuntime,
  sorSchemaName,
} from "../../src/sor";
import type { SorRuntime } from "../../src/sor";
import { createEventSpine } from "../../src/spine";
import type { EventSpine } from "../../src/spine";
import type { Db } from "../../src/db";
import { describePg, freshDb, truncateAll } from "../helpers/pg";

/**
 * P11 acceptance over real Postgres — "SoR migration approved + applied",
 * driven by the REAL AMS descriptor the insurance-brokerage pack ships:
 *   1. propose → the sor_migration gate request exists carrying the exact DDL;
 *   2. apply before approval is refused; after approval the schema and all four
 *      tables exist, each with _id / _origin (not null) / _entity_ref;
 *   3. a row inserted through the scoped handle comes back with its origin
 *      stamped and its entity ref intact;
 *   4. a destructive diff and a hostile identifier are both rejected.
 */

const blobDir = mkdtempSync(join(tmpdir(), "lithis-sor-it-"));

interface Rig {
  db: Db;
  spine: EventSpine;
  gate: HumanGate;
  store: ContextStore;
  sor: SorRuntime;
  tenantId: string;
  principalId: string;
  p: PrincipalContext;
}

async function buildRig(): Promise<Rig> {
  const db = await freshDb();
  const spine = createEventSpine(db);
  const gate = createHumanGate(db, spine);
  const store = createContextStore(db, spine, { blobs: createLocalBlobStorage(blobDir) });
  const tenantId = newUlid();
  const principalId = newUlid();
  return {
    db,
    spine,
    gate,
    store,
    sor: createSorRuntime({ db, spine, humanGate: gate, contextStore: store }),
    tenantId,
    principalId,
    p: { tenantId, principalId, kind: "human" },
  };
}

/** The pack ships a draft that still carries `migrations`; the runtime owns that field. */
function amsDraft(tenantId: string): {
  tenantId: string;
  slug: string;
  displayName: string;
  version: number;
  tables: SorTable[];
} {
  const { migrations: _ownedByTheRuntime, ...rest } = amsSorDescriptor;
  return { ...rest, tenantId };
}

async function approve(rig: Rig, requestId: string): Promise<void> {
  await rig.gate.resolve(
    requestId,
    {
      by: { kind: "principal", id: rig.principalId },
      at: nowIso(),
      verdict: "approved",
      comment: "reviewed the rendered DDL statement by statement",
    },
    rig.p,
  );
}

async function columnsOf(rig: Rig, schema: string, table: string): Promise<Record<string, string>> {
  const rows: { column_name: string; data_type: string; is_nullable: string }[] = await rig.db.sql`
    select column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = ${schema} and table_name = ${table}`;
  return Object.fromEntries(
    rows.map((r) => [r.column_name, `${r.data_type}:${r.is_nullable === "YES" ? "null" : "notnull"}`]),
  );
}

describePg("P11 SoR runtime over Postgres", () => {
  beforeEach(async () => {
    await truncateAll(await freshDb());
  });

  test("AMS round-trip: propose → gate → approve → apply → insert → read back", async () => {
    const rig = await buildRig();
    const schema = sorSchemaName(rig.tenantId, "ams");

    const requestId = await rig.sor.propose(amsDraft(rig.tenantId), rig.p);

    // 1. The gate request exists, is a sor_migration, and carries the exact DDL.
    const request = await rig.gate.get(requestId, rig.tenantId);
    expect(request?.subjectKind).toBe("sor_migration");
    expect(request?.state).toBe("pending");
    const payload = request!.payload as Record<string, unknown>;
    expect(payload["sorSlug"]).toBe("ams");
    expect(payload["version"]).toBe(1);
    expect(payload["schema"]).toBe(schema);
    expect(String(payload["ddl"])).toContain(`create table "${schema}"."policies"`);
    expect(payload["changes"]).toHaveLength(4);
    // The DDL is also an immutable blob, so the card cites bytes, not a string.
    const ddlBlob = new TextDecoder().decode(
      await rig.store.readBlob(rig.tenantId, String(payload["ddlBlobId"])),
    );
    expect(ddlBlob).toBe(String(payload["ddl"]));

    const system = (await rig.sor.getBySlug(rig.tenantId, "ams"))!;
    expect(system.appliedTables).toEqual([]);
    expect(system.appliedVersion).toBeUndefined();
    expect(system.descriptor.migrations[0]?.appliedAt).toBeUndefined();

    // 2. Applying WITHOUT approval is refused.
    await expect(rig.sor.apply(system.descriptor.id, rig.p)).rejects.toThrow(SorNotApprovedError);
    const beforeApply: unknown[] = await rig.db.sql`
      select 1 from information_schema.schemata where schema_name = ${schema}`;
    expect(beforeApply).toHaveLength(0);

    // 3. Approve, then apply for real.
    await approve(rig, requestId);
    await rig.sor.apply(system.descriptor.id, rig.p);

    const schemata: unknown[] = await rig.db.sql`
      select 1 from information_schema.schemata where schema_name = ${schema}`;
    expect(schemata).toHaveLength(1);
    const tables: { table_name: string }[] = await rig.db.sql`
      select table_name from information_schema.tables where table_schema = ${schema}
      order by table_name`;
    expect(tables.map((t) => t.table_name)).toEqual([
      "carriers",
      "clients",
      "commissions",
      "policies",
    ]);

    // Every generated table carries the reserved lithis columns.
    for (const table of ["carriers", "clients", "commissions", "policies"]) {
      const columns = await columnsOf(rig, schema, table);
      expect(columns["_id"]).toBe("text:notnull");
      expect(columns["_origin"]).toBe("jsonb:notnull");
      expect(columns["_entity_ref"]).toBe("jsonb:null");
    }
    // ...and the descriptor's own columns/typing survived.
    const policyColumns = await columnsOf(rig, schema, "policies");
    expect(policyColumns["policy_number"]).toBe("text:notnull");
    expect(policyColumns["annual_premium"]).toBe("numeric:null");
    expect(policyColumns["effective_date"]).toBe("date:notnull");
    expect(policyColumns["limits"]).toBe("jsonb:null");

    // The audit trail lives in the descriptor itself.
    const applied = (await rig.sor.getBySlug(rig.tenantId, "ams"))!;
    expect(applied.appliedVersion).toBe(1);
    expect(applied.appliedTables).toHaveLength(4);
    expect(applied.descriptor.migrations[0]?.appliedAt).toBeString();
    expect(applied.descriptor.migrations[0]?.appliedBy).toBe("human");
    expect(applied.descriptor.migrations[0]?.approvalRequestId).toBe(requestId);

    // 4. Insert through the scoped handle: _origin is stamped, _entityRef kept.
    const entityRef = { kind: "entity" as const, id: newUlid() };
    const policies = rig.sor.table<{
      policy_number: string;
      client_legal_name: string;
      carrier_name: string;
      line_of_business: string;
      effective_date: string;
      expiration_date: string;
      annual_premium: number;
      limits: Record<string, unknown>;
      status: string;
      admitted: boolean;
    }>("ams", "policies", rig.p);

    const inserted = await policies.insert(
      {
        policy_number: "GL-99120",
        client_legal_name: "Harbour Freight Logistics LLC",
        carrier_name: "Meridian Casualty",
        line_of_business: "GL",
        effective_date: "2025-11-01",
        expiration_date: "2026-11-01",
        annual_premium: 41250,
        limits: { occurrence: 1000000, aggregate: 2000000 },
        status: "in_force",
        admitted: true,
      },
      { entityRef },
    );
    expect(inserted._id).toBeString();
    expect(inserted._origin.by).toEqual({ kind: "principal", id: rig.principalId });
    expect(inserted._origin.method).toBe("human");
    expect(inserted._origin.trust).toBe("internal");

    const read = await policies.select({ policy_number: "GL-99120" });
    expect(read).toHaveLength(1);
    expect(read[0]!._id).toBe(inserted._id);
    expect(read[0]!.client_legal_name).toBe("Harbour Freight Logistics LLC");
    expect(read[0]!.limits).toEqual({ occurrence: 1000000, aggregate: 2000000 });
    expect(read[0]!.admitted).toBe(true);
    // Provenance survived the round trip, and so did the entity link.
    expect(read[0]!._origin.by).toEqual({ kind: "principal", id: rig.principalId });
    expect(read[0]!._entityRef).toEqual(entityRef);

    const updated = await policies.update({ policy_number: "GL-99120" }, { status: "cancelled" });
    expect(updated).toBe(1);
    expect((await policies.select({ policy_number: "GL-99120" }))[0]!.status).toBe("cancelled");

    const topics = (
      await rig.spine.readSince({ consumerId: "t", tenantId: rig.tenantId, afterSeq: 0n })
    ).map((e) => e.topic);
    expect(topics).toContain("sor.migration.proposed");
    expect(topics).toContain("sor.migration.applied");
    expect(topics).toContain("sor.row.written");
  });

  test("an additive v2 migration alters the live schema after its own approval", async () => {
    const rig = await buildRig();
    const schema = sorSchemaName(rig.tenantId, "ams");
    const v1 = await rig.sor.propose(amsDraft(rig.tenantId), rig.p);
    await approve(rig, v1);
    const system = (await rig.sor.getBySlug(rig.tenantId, "ams"))!;
    await rig.sor.apply(system.descriptor.id, rig.p);

    const draft = amsDraft(rig.tenantId);
    const clients = draft.tables.find((t) => t.name === "clients")!;
    const v2Draft = {
      ...draft,
      version: 2,
      tables: draft.tables.map((t) =>
        t.name === "clients"
          ? {
              ...clients,
              columns: [
                ...clients.columns,
                { name: "risk_notes", type: "text" as const, nullable: true, description: "Underwriter notes." },
              ],
            }
          : t,
      ),
    };
    const v2 = await rig.sor.propose(v2Draft, rig.p);

    // A second proposal while one is pending is refused.
    await expect(rig.sor.propose(v2Draft, rig.p)).rejects.toThrow(SorProposalPendingError);
    // ...and so is applying it before approval.
    await expect(rig.sor.apply(system.descriptor.id, rig.p)).rejects.toThrow(SorNotApprovedError);

    await approve(rig, v2);
    await rig.sor.apply(system.descriptor.id, rig.p);

    expect(await columnsOf(rig, schema, "clients")).toMatchObject({ risk_notes: "text:null" });
    const after = (await rig.sor.getBySlug(rig.tenantId, "ams"))!;
    expect(after.appliedVersion).toBe(2);
    expect(after.descriptor.migrations).toHaveLength(2);
    expect(after.descriptor.migrations.every((m) => m.appliedAt !== undefined)).toBe(true);
  });

  test("destructive diffs and hostile identifiers are rejected at propose()", async () => {
    const rig = await buildRig();
    const v1 = await rig.sor.propose(amsDraft(rig.tenantId), rig.p);
    await approve(rig, v1);
    const system = (await rig.sor.getBySlug(rig.tenantId, "ams"))!;
    await rig.sor.apply(system.descriptor.id, rig.p);

    // Dropping a table.
    const dropped = amsDraft(rig.tenantId);
    await expect(
      rig.sor.propose(
        { ...dropped, version: 2, tables: dropped.tables.filter((t) => t.name !== "commissions") },
        rig.p,
      ),
    ).rejects.toThrow(SorDestructiveMigrationError);

    // Changing a column's type.
    const retyped = amsDraft(rig.tenantId);
    await expect(
      rig.sor.propose(
        {
          ...retyped,
          version: 2,
          tables: retyped.tables.map((t) =>
            t.name === "policies"
              ? {
                  ...t,
                  columns: t.columns.map((c) =>
                    c.name === "annual_premium" ? { ...c, type: "text" as const } : c,
                  ),
                }
              : t,
          ),
        },
        rig.p,
      ),
    ).rejects.toThrow(/would change type numeric → text/);

    // A hostile table name never reaches SQL.
    const hostile = amsDraft(rig.tenantId);
    await expect(
      rig.sor.propose(
        {
          ...hostile,
          version: 2,
          tables: [
            ...hostile.tables,
            {
              name: 'evil"; drop schema public cascade; --',
              description: "injection attempt",
              columns: [{ name: "a", type: "text" as const, nullable: true }],
            },
          ],
        },
        rig.p,
      ),
    ).rejects.toThrow();

    // A hostile COLUMN name likewise.
    const hostileColumn = amsDraft(rig.tenantId);
    await expect(
      rig.sor.propose(
        {
          ...hostileColumn,
          version: 2,
          tables: hostileColumn.tables.map((t) =>
            t.name === "clients"
              ? {
                  ...t,
                  columns: [
                    ...t.columns,
                    { name: 'x" text; drop table clients; --', type: "text" as const, nullable: true },
                  ],
                }
              : t,
          ),
        },
        rig.p,
      ),
    ).rejects.toThrow();

    // A quote inside a DESCRIPTION is data, not syntax: it is escaped, not rejected.
    const quoted = amsDraft(rig.tenantId);
    const requestId = await rig.sor.propose(
      {
        ...quoted,
        version: 2,
        tables: quoted.tables.map((t) =>
          t.name === "clients"
            ? {
                ...t,
                columns: [
                  ...t.columns,
                  {
                    name: "broker_note",
                    type: "text" as const,
                    nullable: true,
                    description: "It's the broker's note'; drop schema public cascade; --",
                  },
                ],
              }
            : t,
        ),
      },
      rig.p,
    );
    await approve(rig, requestId);
    await rig.sor.apply(system.descriptor.id, rig.p);
    // public survived, and the comment landed verbatim.
    const publicAlive: unknown[] = await rig.db.sql`
      select 1 from information_schema.schemata where schema_name = 'public'`;
    expect(publicAlive).toHaveLength(1);
    const comment: { c: string | null }[] = await rig.db.sql`
      select d.description as c
      from pg_description d
      join pg_class cl on cl.oid = d.objoid
      join pg_namespace n on n.oid = cl.relnamespace
      join pg_attribute a on a.attrelid = cl.oid and a.attnum = d.objsubid
      where n.nspname = ${sorSchemaName(rig.tenantId, "ams")}
        and cl.relname = 'clients' and a.attname = 'broker_note'`;
    expect(comment[0]?.c ?? "").toContain("It's the broker's note'; drop schema public cascade; --");
  });

  test("the scoped handle refuses unknown columns, reserved names and blind updates", async () => {
    const rig = await buildRig();
    const v1 = await rig.sor.propose(amsDraft(rig.tenantId), rig.p);
    await approve(rig, v1);
    const system = (await rig.sor.getBySlug(rig.tenantId, "ams"))!;
    await rig.sor.apply(system.descriptor.id, rig.p);

    const carriers = rig.sor.table<Record<string, unknown>>("ams", "carriers", rig.p);
    await expect(carriers.insert({ name: "Meridian", nope: 1 })).rejects.toThrow(SorColumnError);
    await expect(carriers.insert({ name: "Meridian", _origin: {} })).rejects.toThrow(
      /reserved lithis column/,
    );
    await expect(carriers.insert({ am_best_rating: "A" })).rejects.toThrow(/NOT NULL/);
    await expect(carriers.insert({ name: 42 })).rejects.toThrow(/expects a string/);

    await carriers.insert({ name: "Meridian Casualty" });
    await expect(carriers.select({ unknown_column: "x" })).rejects.toThrow(SorColumnError);
    // `col = NULL` matches nothing — refuse rather than return a silently-empty set.
    await expect(carriers.select({ am_best_rating: null })).rejects.toThrow(/matches no rows/);
    await expect(carriers.update({}, { portal_url: "https://x" })).rejects.toThrow(
      /empty where clause/,
    );
    await expect(carriers.update({ name: "Meridian Casualty" }, {})).rejects.toThrow(
      /empty patch/,
    );
    // A table the descriptor never declared has no handle.
    await expect(
      rig.sor.table<Record<string, unknown>>("ams", "secrets", rig.p).select(),
    ).rejects.toThrow(/no APPLIED table 'secrets'/);
  });

  test("a slug that cannot be a safe Postgres identifier is refused outright", async () => {
    const rig = await buildRig();
    await expect(
      rig.sor.propose(
        {
          tenantId: rig.tenantId,
          slug: "book-of-business",
          displayName: "Book",
          version: 1,
          tables: [
            {
              name: "rows",
              description: "x",
              columns: [{ name: "a", type: "text", nullable: true }],
            },
          ],
        },
        rig.p,
      ),
    ).rejects.toThrow(SorIdentifierError);
  });
});
