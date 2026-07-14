import { describe, expect, test } from "bun:test";
import { newUlid } from "@lithis/core";
import { buildApp } from "../src/api";
import { createContextStore } from "../src/context";
// No humanGate or workQueue: both are real as of P2/P5 and need Postgres —
// this DB-less app exercises the 503 paths; the real routes are covered in
// test/integration/{humangate,work}.pg.test.ts.
const app = buildApp({
  role: "all",
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
    expect(ids).toContain("server.work.queue.claim");
    expect(ids).toContain("server.context.store.search");
    // humangate went real in P2-gate — its stub ids are gone from the census.
    expect(ids.filter((id) => id.startsWith("server.humangate."))).toEqual([]);
    for (const r of census.records) {
      expect(r.reason).toStartWith("LITHIS-STUB:");
    }
  });
});

describe("placeholder domain routes answer 501 with the stub id", () => {
  test("humangate routes → 503 when the server booted without DATABASE_URL", async () => {
    // Real module (P2-gate), missing dependency — a config condition, not a stub.
    const inbox = await app.request("/api/humangate/inbox", { headers: identity });
    expect(inbox.status).toBe(503);
    const post = await app.request("/api/humangate/request", {
      method: "POST",
      headers: { ...identity, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(post.status).toBe(503);
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
