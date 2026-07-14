import { expect, test } from "bun:test";
import { applyMigrations, collectMigrations } from "../../src/db/migrate";
import { describePg, freshDb, testDbUrl } from "../helpers/pg";

describePg("applyMigrations (integration)", () => {
  test("fresh apply creates every module schema and the ledger", async () => {
    const db = await freshDb(); // first call applies the full plan
    const schemas: { schema_name: string }[] = await db.sql`
      select schema_name from information_schema.schemata`;
    const names = schemas.map((s) => s.schema_name);
    for (const schema of ["spine", "iam", "work", "humangate", "context", "processes"]) {
      expect(names).toContain(schema);
    }
    const tables: { table_name: string }[] = await db.sql`
      select table_name from information_schema.tables where table_schema = 'spine'`;
    expect(tables.map((t) => t.table_name).sort()).toEqual([
      "consumer_cursors",
      "events",
      "tenant_seq",
    ]);
    const ledger: { count: bigint | number }[] = await db.sql`
      select count(*)::int as count from public.lithis_migrations`;
    expect(Number(ledger[0]!.count)).toBeGreaterThanOrEqual(11);
  });

  test("re-apply is a no-op (ledger idempotence)", async () => {
    await freshDb();
    const summary = await applyMigrations(testDbUrl!, collectMigrations());
    expect(summary.applied).toEqual([]);
    expect(summary.skipped).toBeGreaterThanOrEqual(11);
  });

  test("checksum drift on an applied migration throws loudly", async () => {
    await freshDb();
    const plan = collectMigrations();
    const tampered = plan.map((m) =>
      m.module === "spine" && m.file === "000_init.sql"
        ? { ...m, sql: `${m.sql}\n-- tampered after apply` }
        : m,
    );
    expect(applyMigrations(testDbUrl!, tampered)).rejects.toThrow(/edited after being applied/);
  });
});
