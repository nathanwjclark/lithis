// connections is REAL as of P3-connect — behavioral coverage lives in
// test/connections.*.test.ts and test/integration/connections.pg.test.ts.
// This file keeps the census honest: the registry has no stub cases left;
// the only remaining connections stub is the ingest sink awaiting P4-context.
// (Census assertions are absence-only — stubkit's own suite resets the global
// registry mid-process, so exact-set equality would be file-order-fragile.)
import { expect, test } from "bun:test";
import { isStub, STUB_MARKER, StubRegistry } from "@lithis/stubkit";
import { createPendingIngestSink } from "../../src/connections";

test("connections registry registers no stubs — the service is implemented", () => {
  const registryStubs = StubRegistry.census().records.filter((r) =>
    r.id.startsWith("server.connections.registry."),
  );
  expect(registryStubs).toEqual([]);
});

test("no connections stub other than the P4-context ingest sink exists", () => {
  const unexpected = StubRegistry.census()
    .records.map((r) => r.id)
    .filter(
      (id) => id.startsWith("server.connections.") && id !== "server.connections.sync.ingest-sink",
    );
  expect(unexpected).toEqual([]);
});

test("the wired ingest sink is still a loud stub until P4-context lands", () => {
  const sink = createPendingIngestSink();
  expect(isStub(sink)).toBe(true);
  expect((sink as unknown as Record<symbol, string>)[STUB_MARKER]).toBe(
    "server.connections.sync.ingest-sink",
  );
});
