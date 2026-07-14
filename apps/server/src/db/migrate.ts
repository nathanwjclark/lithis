import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stub } from "@lithis/stubkit";

/**
 * Migration composition — REAL ordering logic. Each server module owns its
 * own `migrations/` directory (`src/<module>/migrations/NNN_*.sql`); this file
 * composes them in dependency order. Applying to a live database is a stub:
 * the skeleton opens no DB connection.
 */

/**
 * Dependency order for composing module migrations. Modules without a
 * migrations directory are skipped (custody/delivery/sentinel/api own no
 * tables yet).
 */
export const MODULE_ORDER = [
  "spine",
  "iam",
  "agents",
  "work",
  "humangate",
  "context",
  "processes",
  "connections",
  "delivery",
  "skills",
  "artifacts",
  "sor",
  "custody",
  "sentinel",
  "api",
] as const;
export type ServerModule = (typeof MODULE_ORDER)[number];

export interface MigrationFile {
  module: ServerModule;
  /** Basename, e.g. "000_init.sql" — files within a module apply in name order. */
  file: string;
  sql: string;
}

/** apps/server/src — the default root migrations are collected from. */
const defaultSrcRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Read every module's migrations directory (in MODULE_ORDER, files sorted
 * lexicographically within a module) and return the ordered plan.
 */
export function collectMigrations(srcRoot: string = defaultSrcRoot): MigrationFile[] {
  const plan: MigrationFile[] = [];
  for (const module of MODULE_ORDER) {
    const dir = join(srcRoot, module, "migrations");
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      plan.push({ module, file, sql: readFileSync(join(dir, file), "utf8") });
    }
  }
  return plan;
}

/**
 * Apply an ordered migration plan to a live Postgres. Stubbed: the skeleton
 * ships no DB driver and opens no connections.
 */
export type ApplyMigrationsFn = (databaseUrl: string, plan: MigrationFile[]) => Promise<void>;

export const applyMigrations = stub<ApplyMigrationsFn>(
  "server.db.migrate.apply",
  "LITHIS-STUB: applying migrations to a live Postgres (driver, transaction-per-module, applied-migrations ledger) not implemented",
);
