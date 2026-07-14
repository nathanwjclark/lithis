import { describe, expect, test } from "bun:test";
import { isTestPath, scanFile } from "../src/scan";

describe("scanFile — stub census", () => {
  test("collects stub call sites with ids and token status", () => {
    const src = [
      `import { stub } from "@lithis/stubkit";`,
      `export const search = stub<(q: string) => string[]>(`,
      `  "server.context.store.search",`,
      `  "LITHIS-STUB: hybrid search not implemented",`,
      `);`,
    ].join("\n");
    const { stubs, violations } = scanFile("apps/server/src/context/index.ts", src);
    expect(stubs).toHaveLength(1);
    expect(stubs[0]?.id).toBe("server.context.store.search");
    expect(stubs[0]?.hasToken).toBe(true);
    expect(violations).toHaveLength(0);
  });

  test("flags stub calls whose reason lacks the LITHIS-STUB token", () => {
    const src = `const f = stub("some.id", "not done yet");`;
    const { violations } = scanFile("apps/server/src/work/index.ts", src);
    expect(violations.map((v) => v.rule)).toContain("missing-token");
  });

  test("flags non-literal stub ids", () => {
    const src = `const f = stub(dynamicId, someReason);`;
    const { violations } = scanFile("apps/server/src/work/index.ts", src);
    expect(violations.map((v) => v.rule)).toContain("non-literal-stub-id");
  });

  test("handles stubService with generic parameters", () => {
    const src = [
      `const store = stubService<WorkQueue>("server.work.queue", ["open", "claim"],`,
      `  "LITHIS-STUB: queue not built");`,
    ].join("\n");
    const { stubs, violations } = scanFile("apps/server/src/work/index.ts", src);
    expect(stubs[0]?.kind).toBe("stubService");
    expect(stubs[0]?.id).toBe("server.work.queue");
    expect(violations).toHaveLength(0);
  });

  test("does not treat function declarations named stub as call sites", () => {
    const src = `export function stub(id: string) { return id; }`;
    const { stubs } = scanFile("packages/other/src/util.ts", src);
    expect(stubs).toHaveLength(0);
  });
});

describe("scanFile — banned patterns", () => {
  test("flags TODO-shaped throws in source", () => {
    const src = `throw new Error("TODO: wire this up later");`;
    const { violations } = scanFile("apps/server/src/spine/outbox.ts", src);
    expect(violations.map((v) => v.rule)).toContain("todo-throw");
  });

  test("flags hand-constructed NotImplementedError", () => {
    const src = `throw new NotImplementedError("x", "y");`;
    const { violations } = scanFile("apps/server/src/spine/outbox.ts", src);
    expect(violations.map((v) => v.rule)).toContain("raw-not-implemented");
  });

  test("flags dummy-data identifiers in source", () => {
    const src = `const mockData = [{ id: 1 }];`;
    const { violations } = scanFile("apps/portal/src/inbox.tsx", src);
    expect(violations.map((v) => v.rule)).toContain("dummy-data-identifier");
  });

  test("exempts test files from banned patterns but still counts their stubs", () => {
    const src = [
      `const mockData = [{ id: 1 }];`,
      `throw new Error("TODO: fine in tests");`,
    ].join("\n");
    const { violations } = scanFile("packages/core/test/work.test.ts", src);
    expect(violations).toHaveLength(0);
  });
});

describe("isTestPath", () => {
  test("matches test files, test dirs, and fixtures", () => {
    expect(isTestPath("packages/core/test/work.test.ts")).toBe(true);
    expect(isTestPath("packages/core/src/work.test.ts")).toBe(true);
    expect(isTestPath("apps/server/tests/boot.ts")).toBe(true);
    expect(isTestPath("packages/evals/fixtures/brief.ts")).toBe(true);
    expect(isTestPath("apps/server/src/work/index.ts")).toBe(false);
  });
});
