import { describe, expect, test } from "bun:test";
import { expectStub } from "@lithis/evals";
import { amsSorDescriptor } from "@lithis/pack-insurance-brokerage";
import type { SorTable } from "@lithis/core";
import {
  MAX_SOR_SLUG_LENGTH,
  RESERVED_COLUMNS,
  SorDestructiveMigrationError,
  SorIdentifierError,
  createUnconfiguredSorRuntime,
  diffTables,
  quoteIdent,
  quoteLiteral,
  renderCreateTable,
  renderMigration,
  resolveEntityBinding,
  sorSchemaName,
  validateTables,
} from "../../src/sor";

/**
 * P11 unit coverage for the SoR module's pure DDL logic. The threat model is
 * the point: descriptors are DATA (packs ship them, agents draft them), so the
 * injection cases below are load-bearing, not decoration. The live
 * propose→approve→apply→insert round-trip lives in
 * test/integration/sor.pg.test.ts.
 */

const TENANT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SCHEMA = `sor_${TENANT.toLowerCase()}_ams`;

const CLIENTS: SorTable = {
  name: "clients",
  description: "Insured clients.",
  columns: [
    { name: "legal_name", type: "text", nullable: false, entityBinding: "company" },
    { name: "active", type: "boolean", nullable: false },
  ],
};

describe("sor identifiers (hostile input)", () => {
  test("schema name is sor_{lowercased tenant}_{slug}", () => {
    expect(sorSchemaName(TENANT, "ams")).toBe(SCHEMA);
    expect(SCHEMA.length).toBeLessThanOrEqual(63);
  });

  test("quoteIdent rejects everything that is not strict snake_case", () => {
    expect(quoteIdent("legal_name", "column")).toBe('"legal_name"');
    for (const hostile of [
      'a"; drop table x; --',
      "a b",
      "Aa",
      "1a",
      "_leading",
      "a-b",
      "",
      "ä",
      "a".repeat(64),
    ]) {
      expect(() => quoteIdent(hostile, "column")).toThrow(SorIdentifierError);
    }
  });

  test("reserved columns are only quotable through the explicit opt-in", () => {
    expect(() => quoteIdent("_origin", "column")).toThrow(SorIdentifierError);
    expect(quoteIdent("_origin", "reserved", { allowReserved: true })).toBe('"_origin"');
    expect(() => quoteIdent("_nope", "reserved", { allowReserved: true })).toThrow(
      SorIdentifierError,
    );
    expect([...RESERVED_COLUMNS]).toEqual(["_id", "_origin", "_entity_ref"]);
  });

  test("quoteLiteral doubles single quotes so descriptions cannot break out", () => {
    expect(quoteLiteral("it's fine")).toBe("'it''s fine'");
    expect(quoteLiteral("x'; drop schema public cascade; --")).toBe(
      "'x''; drop schema public cascade; --'",
    );
  });

  test("a hostile identifier anywhere in a descriptor is rejected before any SQL is built", () => {
    expect(() =>
      validateTables([{ ...CLIENTS, name: 'clients"; drop schema public cascade; --' }]),
    ).toThrow();
    expect(() =>
      validateTables([
        { ...CLIENTS, columns: [{ name: 'x"; drop table y; --', type: "text", nullable: true }] },
      ]),
    ).toThrow();
    // Reserved names can never be claimed by a user column.
    expect(() =>
      validateTables([{ ...CLIENTS, columns: [{ name: "_origin", type: "text", nullable: true }] }]),
    ).toThrow();
    // Unknown column types never reach SQL.
    expect(() =>
      validateTables([{ ...CLIENTS, columns: [{ name: "x", type: "money", nullable: true }] }]),
    ).toThrow();
  });

  test("a slug too long for a Postgres identifier is rejected, not truncated", () => {
    expect(() => sorSchemaName(TENANT, "a".repeat(MAX_SOR_SLUG_LENGTH + 1))).toThrow(/at most 32/);
    expect(() => sorSchemaName("not-a-ulid", "ams")).toThrow(/26-character ULID/);
  });
});

describe("sor DDL generation", () => {
  test("every generated table carries _id, _origin (not null) and _entity_ref", () => {
    const create = renderCreateTable(SCHEMA, CLIENTS)[0]!;
    expect(create).toContain(`create table "${SCHEMA}"."clients"`);
    expect(create).toContain('"_id" text primary key');
    expect(create).toContain('"_origin" jsonb not null');
    expect(create).toContain('"_entity_ref" jsonb');
    expect(create).toContain('"legal_name" text not null');
    expect(create).toContain('"active" boolean not null');
  });

  test("the real AMS pack descriptor renders a complete first migration", () => {
    const rendered = renderMigration(TENANT, "ams", 1, [], amsSorDescriptor.tables);
    expect(rendered.schema).toBe(SCHEMA);
    expect(rendered.sql).toContain(`create schema if not exists "${SCHEMA}"`);
    for (const table of ["clients", "policies", "carriers", "commissions"]) {
      expect(rendered.sql).toContain(`create table "${SCHEMA}"."${table}"`);
    }
    // entityBinding metadata survives into a column comment.
    expect(rendered.sql).toContain("[entityBinding: company]");
    expect(rendered.summary.length).toBe(4);
  });

  test("an additive diff produces ALTER ... ADD COLUMN only", () => {
    const next: SorTable[] = [
      { ...CLIENTS, columns: [...CLIENTS.columns, { name: "fein", type: "text", nullable: true }] },
    ];
    const diff = diffTables(SCHEMA, [CLIENTS], next);
    expect(diff.destructive).toEqual([]);
    expect(diff.statements).toEqual([`alter table "${SCHEMA}"."clients" add column "fein" text;`]);
  });

  test("destructive diffs are REJECTED, never half-applied", () => {
    const dropTable = (): unknown =>
      renderMigration(TENANT, "ams", 2, [CLIENTS], [
        { name: "other", description: "x", columns: [{ name: "a", type: "text", nullable: true }] },
      ]);
    expect(dropTable).toThrow(SorDestructiveMigrationError);
    try {
      dropTable();
    } catch (err) {
      expect((err as SorDestructiveMigrationError).changes.join(" ")).toContain(
        "table 'clients' would be dropped",
      );
    }

    const dropColumn: SorTable[] = [{ ...CLIENTS, columns: [CLIENTS.columns[0]!] }];
    expect(() => renderMigration(TENANT, "ams", 2, [CLIENTS], dropColumn)).toThrow(
      /column 'clients.active' would be dropped/,
    );

    const retype: SorTable[] = [
      {
        ...CLIENTS,
        columns: [CLIENTS.columns[0]!, { name: "active", type: "text", nullable: false }],
      },
    ];
    expect(() => renderMigration(TENANT, "ams", 2, [CLIENTS], retype)).toThrow(
      /would change type boolean → text/,
    );

    const notNullAdd: SorTable[] = [
      { ...CLIENTS, columns: [...CLIENTS.columns, { name: "fein", type: "text", nullable: false }] },
    ];
    expect(() => renderMigration(TENANT, "ams", 2, [CLIENTS], notNullAdd)).toThrow(
      /would be added NOT NULL to an existing table/,
    );
  });

  test("a no-op proposal is an error, not an empty migration", () => {
    expect(() => renderMigration(TENANT, "ams", 2, [CLIENTS], [CLIENTS])).toThrow(
      /proposes no schema change/,
    );
  });
});

describe("sor stubs + config degrade", () => {
  test("automatic entityBinding resolution is a loud registered stub", () => {
    const err = expectStub(() => resolveEntityBinding(TENANT, "company", "Acme"));
    expect(err.stubId).toBe("server.sor.runtime.entity_binding");
    expect(err.reason).toStartWith("LITHIS-STUB:");
  });

  test("DB-less mode fails with a config error, not a stub", () => {
    expect(() => createUnconfiguredSorRuntime().list(TENANT)).toThrow(/DATABASE_URL is not set/);
  });
});
