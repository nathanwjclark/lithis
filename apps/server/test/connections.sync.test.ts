import { describe, expect, test } from "bun:test";
import { connectionSchema, newUlid, nowIso } from "@lithis/core";
import type { Connection } from "@lithis/core";
import { isDueForSync } from "../src/connections";

function connection(overrides: {
  status?: Connection["status"];
  lastSyncAt?: string;
}): Connection {
  const at = nowIso();
  return connectionSchema.parse({
    id: newUlid(),
    tenantId: newUlid(),
    connectorSlug: "fake-slack",
    displayName: "Fake Slack",
    credentialRef: newUlid(),
    scopes: [],
    status: overrides.status ?? "healthy",
    health: {},
    syncState: {
      cursorsByFeed: {},
      ...(overrides.lastSyncAt !== undefined ? { lastSyncAt: overrides.lastSyncAt } : {}),
    },
    createdAt: at,
    updatedAt: at,
  });
}

describe("isDueForSync (scheduling decision)", () => {
  const now = new Date("2026-01-01T12:00:00Z");

  test("never-synced connections are due immediately", () => {
    expect(isDueForSync(connection({}), now, 5)).toBe(true);
  });

  test("recently-attempted connections wait out the interval", () => {
    expect(isDueForSync(connection({ lastSyncAt: "2026-01-01T11:58:00Z" }), now, 5)).toBe(false);
    expect(isDueForSync(connection({ lastSyncAt: "2026-01-01T11:55:00Z" }), now, 5)).toBe(true);
    expect(isDueForSync(connection({ lastSyncAt: "2026-01-01T11:54:59Z" }), now, 5)).toBe(true);
  });

  test("degraded connections keep retrying on schedule", () => {
    expect(
      isDueForSync(connection({ status: "degraded", lastSyncAt: "2026-01-01T11:00:00Z" }), now, 5),
    ).toBe(true);
  });

  test("disabled and expired connections never sync", () => {
    expect(isDueForSync(connection({ status: "disabled" }), now, 5)).toBe(false);
    expect(isDueForSync(connection({ status: "expired" }), now, 5)).toBe(false);
  });
});
