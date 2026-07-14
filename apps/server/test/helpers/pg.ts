import { describe } from "bun:test";
import { SQL } from "bun";
import { createDb, type Db } from "../../src/db";
import { applyMigrations, collectMigrations } from "../../src/db/migrate";

/**
 * Postgres integration-test harness. Gated on LITHIS_TEST_DATABASE_URL —
 * deliberately NOT DATABASE_URL, because this harness TRUNCATES tables and
 * must never point at a seeded dev database. Without the env var, integration
 * suites skip locally; in CI they are mandatory (the guard below makes a
 * silently-skipping CI run impossible).
 */

export const testDbUrl = process.env["LITHIS_TEST_DATABASE_URL"];

if (process.env["CI"] !== undefined && (testDbUrl === undefined || testDbUrl.length === 0)) {
  throw new Error(
    "CI is set but LITHIS_TEST_DATABASE_URL is not — integration tests would silently skip; " +
      "wire the postgres service into the workflow",
  );
}

/** describe.skipIf(no test database) — wrap every integration suite in this. */
export function describePg(name: string, fn: () => void): void {
  describe.skipIf(testDbUrl === undefined || testDbUrl.length === 0)(name, fn);
}

/** Create the database named in the URL if it does not exist yet. */
async function ensureDatabase(url: string): Promise<void> {
  const parsed = new URL(url);
  const dbName = parsed.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const sql = new SQL({ url: admin.toString() });
  try {
    const rows: unknown[] = await sql`select 1 from pg_database where datname = ${dbName}`;
    if (rows.length === 0) {
      await sql.unsafe(`create database "${dbName}"`);
    }
  } finally {
    await sql.close({ timeout: 5 });
  }
}

let memo: Db | undefined;

/**
 * Connect to the test database, creating + migrating it on first use (the
 * migration ledger makes re-runs no-ops). One Db per test process; bun runs
 * test files sequentially, so truncate-between-tests is race-free.
 */
export async function freshDb(): Promise<Db> {
  if (memo !== undefined) return memo;
  if (testDbUrl === undefined) {
    throw new Error("freshDb() called without LITHIS_TEST_DATABASE_URL — wrap the suite in describePg");
  }
  await ensureDatabase(testDbUrl);
  await applyMigrations(testDbUrl, collectMigrations());
  memo = createDb(testDbUrl);
  return memo;
}

/** Wipe phase-1 state between tests (extend the list as later phases land). */
export async function truncateAll(db: Db): Promise<void> {
  await db.sql`
    truncate table
      spine.events,
      spine.consumer_cursors,
      spine.tenant_seq,
      iam.tenants,
      iam.principals,
      iam.agent_charters,
      iam.action_intents,
work.work_items,
      work.work_edges,
      work.work_notes,
      humangate.human_requests
    cascade`;
}
