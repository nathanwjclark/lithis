// context is REAL as of phase P4 — behavioral coverage lives in
// test/context.*.test.ts (chunker, distill parsing, fusion, embeddings,
// blob drivers) and test/integration/context.pg.test.ts. This file remains
// only to assert the module intentionally has no stub cases left.
import { expect, test } from "bun:test";
import { StubRegistry } from "@lithis/stubkit";

test("context registers no stubs — the module is implemented", () => {
  const contextStubs = StubRegistry.census().records.filter((r) =>
    r.id.startsWith("server.context."),
  );
  expect(contextStubs).toEqual([]);
});
