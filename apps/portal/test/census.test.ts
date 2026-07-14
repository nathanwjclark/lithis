import { describe, expect, test } from "bun:test";
import type { StubRecord } from "@lithis/stubkit";
import { areaOf, filterByPrefixes, groupCensus } from "../src/ui/census";

const AT = "2026-07-14T00:00:00.000Z";

function record(id: string, invocations = 0): StubRecord {
  return { id, reason: `LITHIS-STUB: fixture for ${id}`, registeredAt: AT, invocations };
}

const FIXTURES: StubRecord[] = [
  record("server.work.queue.claim", 3),
  record("server.context.store.search"),
  record("server.context.store.ingestDoc", 1),
  record("sdk.connectors.act"),
  record("workbench.session.open", 2),
  record("server.work.queue.open"),
];

describe("areaOf", () => {
  test("takes the first two dot segments", () => {
    expect(areaOf("server.context.store.search")).toBe("server.context");
    expect(areaOf("sdk.connectors.act")).toBe("sdk.connectors");
  });

  test("falls back to the whole id when shorter", () => {
    expect(areaOf("workbench")).toBe("workbench");
  });
});

describe("groupCensus", () => {
  test("groups by area prefix, sorted, with counts", () => {
    const groups = groupCensus(FIXTURES);
    expect(groups.map((g) => g.area)).toEqual([
      "sdk.connectors",
      "server.context",
      "server.work",
      "workbench.session",
    ]);

    const context = groups[1];
    expect(context?.records.map((r) => r.id)).toEqual([
      "server.context.store.ingestDoc",
      "server.context.store.search",
    ]);
    expect(context?.invocations).toBe(1);
    expect(context?.invoked).toBe(1);

    const work = groups[2];
    expect(work?.records.map((r) => r.id)).toEqual([
      "server.work.queue.claim",
      "server.work.queue.open",
    ]);
    expect(work?.invocations).toBe(3);
    expect(work?.invoked).toBe(1);
  });

  test("empty census yields no groups", () => {
    expect(groupCensus([])).toEqual([]);
  });
});

describe("filterByPrefixes", () => {
  test("selects only records matching any prefix, sorted by id", () => {
    const filtered = filterByPrefixes(FIXTURES, ["server.work.", "workbench."]);
    expect(filtered.map((r) => r.id)).toEqual([
      "server.work.queue.claim",
      "server.work.queue.open",
      "workbench.session.open",
    ]);
  });

  test("no prefixes selects nothing", () => {
    expect(filterByPrefixes(FIXTURES, [])).toEqual([]);
  });
});
