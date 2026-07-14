// spine is REAL as of phase 1 — behavioral coverage lives in
// test/spine.selector.test.ts, test/spine.clock.test.ts, and
// test/integration/spine.pg.test.ts. This file remains only to document that
// the module intentionally has no stub cases left.
import { expect, test } from "bun:test";
import { StubRegistry } from "@lithis/stubkit";

test("spine registers no stubs — the module is implemented", () => {
  const spineStubs = StubRegistry.census().records.filter((r) => r.id.startsWith("server.spine."));
  expect(spineStubs).toEqual([]);
});
