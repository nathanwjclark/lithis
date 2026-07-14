import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQL } from "bun";

/**
 * Migration composition + application. Each server module owns its own
 * `migrations/` directory (`src/<module>/migrations/NNN_*.sql`); this file
 * composes them in dependency order and applies them idempotently against a
 * ledger (`public.lithis_migrations`). Applied files are checksum-locked:
 * editing an already-applied migration is a loud error — write a new
 * `NNN_*.sql` file instead.
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

export type ApplyMigrationsFn = (
  databaseUrl: string,
  plan: MigrationFile[],
) => Promise<MigrationSummary>;

export interface MigrationSummary {
  applied: { module: ServerModule; file: string }[];
  skipped: number;
}

function sha256(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

/**
 * Apply an ordered migration plan to a live Postgres. One transaction per
 * module; within it, each file is skipped when its ledger row exists with a
 * matching checksum, applied + recorded otherwise. The ledger table is
 * bootstrapped here (not as a module migration — it must pre-exist them all).
 */
export async function applyMigrations(
  databaseUrl: string,
  plan: MigrationFile[],
): Promise<MigrationSummary> {
  const sql = new SQL({ url: databaseUrl });
  const summary: MigrationSummary = { applied: [], skipped: 0 };
  try {
    await sql`
      create table if not exists public.lithis_migrations (
        module     text not null,
        file       text not null,
        checksum   text not null,
        applied_at timestamptz not null default now(),
        primary key (module, file)
      )`;

    const modules = [...new Set(plan.map((m) => m.module))];
    for (const module of modules) {
      const files = plan.filter((m) => m.module === module);
      await sql.begin(async (tx) => {
        for (const m of files) {
          const checksum = sha256(m.sql);
          const rows: { checksum: string }[] = await tx`
            select checksum from public.lithis_migrations
            where module = ${m.module} and file = ${m.file}`;
          const existing = rows[0];
          if (existing !== undefined) {
            if (existing.checksum !== checksum) {
              throw new Error(
                `migration ${m.module}/${m.file} was edited after being applied ` +
                  `(ledger checksum ${existing.checksum.slice(0, 12)}…, file ${checksum.slice(0, 12)}…) — ` +
                  `never modify applied migrations; add a new NNN_*.sql file instead`,
              );
            }
            summary.skipped += 1;
            continue;
          }
          // Migration files are multi-statement DDL authored in-repo — unsafe()
          // (never split on ';': dollar-quoted bodies would break).
          await tx.unsafe(m.sql);
          await tx`
            insert into public.lithis_migrations (module, file, checksum)
            values (${m.module}, ${m.file}, ${checksum})`;
          summary.applied.push({ module: m.module, file: m.file });
        }
      });
    }
    return summary;
  } finally {
    await sql.close({ timeout: 5 });
  }
}

if (import.meta.main) {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    console.error("DATABASE_URL is not set — nothing to migrate against");
    process.exit(1);
  }
  const summary = await applyMigrations(databaseUrl, collectMigrations());
  for (const m of summary.applied) console.log(`applied ${m.module}/${m.file}`);
  console.log(`migrations: ${summary.applied.length} applied, ${summary.skipped} already up to date`);
}
