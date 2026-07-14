import { describe, expect, test } from "bun:test";
import { newUlid } from "@lithis/core";
import { buildApp } from "../src/api";
import { createContextStore } from "../src/context";
import { createHumanGate } from "../src/humangate";

// No workQueue: this suite exercises the DB-less surface (work is real as of
// P5 and needs Postgres — its route behavior over a live queue is covered by
// test/integration/work.pg.test.ts).
const app = buildApp({
  role: "all",
  humanGate: createHumanGate(),
  contextStore: createContextStore(),
  startedAtMs: Date.now() - 5_000,
});

/** Dev-header identity for the placeholder routes (fixture ULIDs). */
const identity = {
  "x-lithis-tenant": newUlid(),
  "x-lithis-principal": newUlid(),
};

describe("GET /health", () => {
  test("returns ok + role + uptime", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; role: string; uptime: number };
    expect(body.ok).toBe(true);
    expect(body.role).toBe("all");
    expect(body.uptime).toBeGreaterThanOrEqual(5);
  });
});

describe("GET /stubs", () => {
  test("serves the live stub census", async () => {
    const res = await app.request("/stubs");
    expect(res.status).toBe(200);
    const census = (await res.json()) as {
      total: number;
      invoked: number;
      records: { id: string; reason: string }[];
    };
    expect(census.total).toBeGreaterThan(0);
    const ids = census.records.map((r) => r.id);
    expect(ids).toContain("server.humangate.gate.inbox");
    expect(ids).toContain("server.context.store.search");
    for (const r of census.records) {
      expect(r.reason).toStartWith("LITHIS-STUB:");
    }
  });
});

describe("placeholder domain routes answer 501 with the stub id", () => {
  test("GET /api/humangate/inbox → 501 { stubId, reason }", async () => {
    const res = await app.request("/api/humangate/inbox", { headers: identity });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { stubId: string; reason: string };
    expect(body.stubId).toBe("server.humangate.gate.inbox");
    expect(body.reason).toStartWith("LITHIS-STUB:");
  });

  test("POST /api/work/claim → 503 when the server has no database", async () => {
    const res = await app.request("/api/work/claim", { method: "POST", headers: identity });
    expect(res.status).toBe(503);
  });

  test("GET /api/context/search → 501 with server.context.store.search", async () => {
    const res = await app.request("/api/context/search?q=loss+runs", { headers: identity });
    expect(res.status).toBe(501);
    expect(((await res.json()) as { stubId: string }).stubId).toBe("server.context.store.search");
  });
});

describe("request validation stays a 400, not a stub 501", () => {
  test("missing identity headers", async () => {
    const res = await app.request("/api/humangate/inbox");
    expect(res.status).toBe(400);
  });

  test("invalid principal ULID", async () => {
    const res = await app.request("/api/work/claim", {
      method: "POST",
      headers: { "x-lithis-tenant": newUlid(), "x-lithis-principal": "not-a-ulid" },
    });
    expect(res.status).toBe(400);
  });

  test("search without q", async () => {
    const res = await app.request("/api/context/search", { headers: identity });
    expect(res.status).toBe(400);
  });
});
