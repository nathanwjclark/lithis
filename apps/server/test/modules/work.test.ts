// work is REAL as of phase 5 — behavioral coverage lives in
// test/work.state.test.ts and test/integration/work.pg.test.ts. This file
// remains only to document that the module intentionally has no stub cases left.
import { expect, test } from "bun:test";
import { StubRegistry } from "@lithis/stubkit";

test("work registers no stubs — the queue is implemented", () => {
  const workStubs = StubRegistry.census().records.filter((r) => r.id.startsWith("server.work."));
  expect(workStubs).toEqual([]);
});
