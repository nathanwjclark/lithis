import { describe, expect, test } from "bun:test";
import { newUlid } from "@lithis/core";
import { buildApp } from "../src/api";
import type { ContextStore } from "../src/context";

/**
 * In-test ContextStore double (context is REAL as of P4 — its Postgres
 * behavior is covered in test/integration/context.pg.test.ts; these api tests
 * only exercise route plumbing, so a recording fake is exactly right here).
 * No humanGate or workQueue: both are real as of P2/P5 and need Postgres —
 * this DB-less app exercises their 503 paths.
 */
const searchCalls: unknown[] = [];
const fixtureDocId = newUlid();
const fakeContextStore: ContextStore = {
  putBlob: async () => ({ kind: "blob", id: fixtureDocId }),
  ingestDoc: async () => ({ kind: "doc", id: fixtureDocId }),
  distill: async () => {
    throw new Error("not exercised by api tests");
  },
  search: async (q) => {
    searchCalls.push(q);
    return [{ ref: { kind: "doc", id: fixtureDocId }, score: 0.5, excerpt: `hit for ${q.text}` }];
  },
  paths: async () => [],
};

const app = buildApp({
  role: "all",
  contextStore: fakeContextStore,
  startedAtMs: Date.now() - 5_000,
});

/** Dev-header identity for the routes (fixture ULIDs). */
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
// work (P5), humangate (P2), and context (P4) went real — their stub ids left the census.
    expect(ids.filter((id) => id.startsWith("server.work."))).toEqual([]);
    expect(ids.filter((id) => id.startsWith("server.humangate."))).toEqual([]);
    expect(ids.filter((id) => id.startsWith("server.context."))).toEqual([]);
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

  test("action-batch routes → 503 when the server has no database", async () => {
    const propose = await app.request("/api/iam/action-batches", {
      method: "POST",
      headers: { ...identity, "content-type": "application/json" },
      body: JSON.stringify({
        summary: "connect with prospects",
        items: [{ capability: "browser.linkedin.connect", summary: "Connect with Jane Roe" }],
      }),
    });
    expect(propose.status).toBe(503);
    const execute = await app.request(`/api/iam/action-batches/${newUlid()}/execute`, {
      method: "POST",
      headers: identity,
    });
    expect(execute.status).toBe(503);
  });
});

describe("context routes are real", () => {
  test("GET /api/context/search → 200 with ScoredRefs and parsed params", async () => {
    const res = await app.request(
      "/api/context/search?q=loss+runs&audience=all&limit=5&docType=email",
      { headers: identity },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ref: { kind: string }; excerpt: string }[];
    expect(body.length).toBe(1);
    expect(body[0]!.ref.kind).toBe("doc");
    expect(body[0]!.excerpt).toContain("loss runs");
    expect(searchCalls.at(-1)).toEqual({
      text: "loss runs",
      audience: "all",
      limit: 5,
      docTypes: ["email"],
    });
  });

  test("GET /api/context/search rejects a bad audience with 400", async () => {
    const res = await app.request("/api/context/search?q=x&audience=everyone", {
      headers: identity,
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/context/docs → 201 with blob + doc refs", async () => {
    const res = await app.request("/api/context/docs", {
      method: "POST",
      headers: { ...identity, "content-type": "application/json" },
      body: JSON.stringify({
        type: "note",
        slug: "hello-note",
        title: "Hello",
        text: "Some ingested text.",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { blob: { kind: string }; doc: { kind: string } };
    expect(body.blob.kind).toBe("blob");
    expect(body.doc.kind).toBe("doc");
  });

  test("POST /api/context/docs rejects an invalid body with 400", async () => {
    const res = await app.request("/api/context/docs", {
      method: "POST",
      headers: { ...identity, "content-type": "application/json" },
      body: JSON.stringify({ title: "missing everything else" }),
    });
    expect(res.status).toBe(400);
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
