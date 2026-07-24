import { describe, expect, test } from "bun:test";
import { collectMigrations, MODULE_ORDER } from "../src/db/migrate";

/** Modules that own tables in the skeleton. */
const MODULES_WITH_MIGRATIONS = [
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
] as const;

describe("collectMigrations (real filesystem)", () => {
  const plan = collectMigrations();

  test("covers exactly the modules that own tables", () => {
    const modules = [...new Set(plan.map((m) => m.module))];
    expect(modules).toEqual([...MODULES_WITH_MIGRATIONS]);
  });

  test("modules appear in MODULE_ORDER", () => {
    const modules = plan.map((m) => m.module);
    const order = modules.map((m) => MODULE_ORDER.indexOf(m));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // spine must come first, iam second — everything references them.
    expect(modules[0]).toBe("spine");
    expect(modules[1]).toBe("iam");
  });

  test("modules without tables are skipped", () => {
    const modules = new Set(plan.map((m) => m.module));
    for (const skipped of ["custody", "sentinel", "api"]) {
      expect(modules.has(skipped as (typeof plan)[number]["module"])).toBe(false);
    }
  });

  test("every module has a 000_init.sql and files sort within a module", () => {
    for (const module of MODULES_WITH_MIGRATIONS) {
      const files = plan.filter((m) => m.module === module).map((m) => m.file);
      expect(files[0]).toBe("000_init.sql");
      expect(files).toEqual([...files].sort());
    }
  });

  test("every 000_init is real DDL with the tenancy + timestamp conventions", () => {
    for (const m of plan.filter((f) => f.file === "000_init.sql")) {
      expect(m.sql).toContain("create table if not exists");
      expect(m.sql).toContain("tenant_id");
      expect(m.sql).toContain("timestamptz");
      expect(m.sql).toContain(`create schema if not exists`);
    }
  });

  /**
   * Follow-on migrations are not required to create tables (P11's
   * sor/001_applied_state.sql only adds columns) — but they must still be real,
   * idempotent DDL, never an empty or comment-only file that silently "applies".
   */
  test("follow-on migrations are real, idempotent DDL", () => {
    for (const m of plan.filter((f) => f.file !== "000_init.sql")) {
      const statements = m.sql
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim();
      expect(statements.length).toBeGreaterThan(0);
      expect(statements).toMatch(/\b(create|alter|drop|insert|update)\b/i);
      expect(statements).toMatch(/if (not )?exists/i);
    }
  });

  test("expected tables exist in the composed DDL", () => {
    const all = plan.map((m) => m.sql).join("\n");
    for (const table of [
      "spine.events",
      "iam.tenants",
      "iam.principals",
      "iam.agent_charters",
      "iam.action_intents",
      "agents.sessions",
      "agents.runs",
      "agents.run_results",
      "agents.evidence",
      "work.work_items",
      "work.work_edges",
      "work.work_notes",
      "humangate.human_requests",
      "context.blobs",
      "context.docs",
      "context.entities",
      "context.links",
      "context.chunks",
      "processes.process_templates",
      "processes.process_runs",
      "processes.watch_rules",
      "connections.connections",
      "connections.feed_expectations",
      "connections.credentials",
      "delivery.deliveries",
      "skills.skills",
      "skills.skill_versions",
      "skills.report_definitions",
      "artifacts.templates",
      "artifacts.artifacts",
      "sor.sor_descriptors",
    ]) {
      expect(all).toContain(`create table if not exists ${table}`);
    }
  });

  test("chunks carry the pgvector embedding column (with jsonb fallback note)", () => {
    const context = plan.find((m) => m.module === "context");
    expect(context?.sql).toContain("vector(1536)");
    expect(context?.sql?.toLowerCase()).toContain("jsonb");
  });

  test("an empty root yields an empty plan", () => {
    expect(collectMigrations("/nonexistent-lithis-src-root")).toEqual([]);
  });
});

// applyMigrations is REAL as of phase 1 — behavioral coverage (fresh apply,
// idempotent re-run, checksum drift) lives in test/integration/migrate.pg.test.ts.
