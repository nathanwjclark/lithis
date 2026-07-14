import { beforeEach, describe, expect, test } from "bun:test";
import { IllegalTransitionError, newUlid } from "@lithis/core";
import type { HumanResolution, PrincipalContext } from "@lithis/core";
import { buildApp } from "../../src/api";
import { createContextStore } from "../../src/context";
import { createHumanGate, slaTickSource } from "../../src/humangate";
import type { NewHumanRequest } from "../../src/humangate";
import { createEventSpine } from "../../src/spine";
import { createWorkQueue } from "../../src/work";
import { describePg, freshDb, truncateAll } from "../helpers/pg";

const HOUR_MS = 3_600_000;

function principal(tenantId: string, principalId: string): PrincipalContext {
  return { tenantId, principalId, kind: "human" };
}

function newRequest(
  tenantId: string,
  assigneeId: string,
  overrides: Partial<NewHumanRequest> = {},
): NewHumanRequest {
  return {
    kind: "approval",
    subjectKind: "action",
    subjectRef: { kind: "action_intent", id: newUlid() },
    payload: { capability: "gmail.send" },
    evidenceIds: [],
    summary: "Send the renewal follow-up email to Acme?",
    routing: {
      assignee: { kind: "principal", id: assigneeId },
      channelPrefs: ["portal"],
      escalationPath: [],
      followUpCount: 0,
    },
    requestedBy: { kind: "principal", id: newUlid() },
    tenantId,
    ...overrides,
  };
}

function resolution(by: string, verdict: HumanResolution["verdict"], comment = "ok"): HumanResolution {
  return { by: { kind: "principal", id: by }, at: new Date().toISOString(), verdict, comment };
}

describePg("HumanGate (integration)", () => {
  beforeEach(async () => {
    await truncateAll(await freshDb());
  });

  test("request → inbox → resolve round-trip, with both events on the spine", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const gate = createHumanGate(db, spine);
    const tenantId = newUlid();
    const responderId = newUlid();
    const p = principal(tenantId, responderId);

    const created = await gate.request(newRequest(tenantId, responderId, { routing: {
      assignee: { kind: "principal", id: responderId },
      channelPrefs: ["portal", "slack"],
      slaHours: 4,
      escalationPath: [],
      followUpCount: 0,
    }}));
    expect(created.state).toBe("pending");
    // slaHours schedules the first follow-up wake from creation.
    expect(Date.parse(created.routing.nextFollowUpAt!)).toBe(
      Date.parse(created.createdAt) + 4 * HOUR_MS,
    );

    const inbox = await gate.inbox(p);
    expect(inbox.map((r) => r.id)).toEqual([created.id]);
    expect(inbox[0]).toEqual(created);

    const resolved = await gate.resolve(created.id, resolution(responderId, "approved", "looks right"), p);
    expect(resolved.state).toBe("approved");
    expect(resolved.resolution?.comment).toBe("looks right");

    // Resolved requests leave the default inbox; includeResolved widens.
    expect(await gate.inbox(p)).toEqual([]);
    const widened = await gate.inbox(p, { includeResolved: true });
    expect(widened.map((r) => r.state)).toEqual(["approved"]);

    const events = await spine.readSince(
      { consumerId: "t", tenantId, afterSeq: 0n },
      { topics: ["humangate.*"] },
    );
    expect(events.map((e) => e.topic)).toEqual(["humangate.requested", "humangate.resolved"]);
    expect(events[0]!.payload).toEqual({ kind: "approval", subjectKind: "action" });
    expect(events[0]!.subjectRefs).toContainEqual({ kind: "human_request", id: created.id });
    expect(events[1]!.payload).toEqual({ verdict: "approved" });
  });

  test("illegal transitions are rejected: double-resolve throws, unknown id is not-found", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const gate = createHumanGate(db, spine);
    const tenantId = newUlid();
    const responderId = newUlid();
    const p = principal(tenantId, responderId);

    const created = await gate.request(newRequest(tenantId, responderId));
    await gate.resolve(created.id, resolution(responderId, "denied", "not now"), p);

    expect(gate.resolve(created.id, resolution(responderId, "approved"), p)).rejects.toThrow(
      IllegalTransitionError,
    );
    // The denial stands untouched.
    const after = await gate.inbox(p, { includeResolved: true });
    expect(after[0]!.state).toBe("denied");
    expect(after[0]!.resolution?.comment).toBe("not now");

    expect(gate.resolve(newUlid(), resolution(responderId, "approved"), p)).rejects.toThrow(
      /not found/,
    );
    // Tenant scoping: another tenant cannot see (or resolve) this request.
    const foreign = principal(newUlid(), responderId);
    expect(gate.resolve(created.id, resolution(responderId, "approved"), foreign)).rejects.toThrow(
      /not found/,
    );
  });

  test("inbox scopes by assignee and filters by kinds/subjectKinds", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const gate = createHumanGate(db, spine);
    const tenantId = newUlid();
    const alice = newUlid();
    const bob = newUlid();

    const mine = await gate.request(newRequest(tenantId, alice));
    const question = await gate.request(
      newRequest(tenantId, alice, { kind: "question", subjectKind: "record_field" }),
    );
    await gate.request(newRequest(tenantId, bob)); // assigned to someone else
    const roleRouted = await gate.request(
      newRequest(tenantId, alice, {
        routing: { assignee: "underwriter", channelPrefs: ["portal"], escalationPath: [], followUpCount: 0 },
      }),
    );

    const p = principal(tenantId, alice);
    // Ref assignees are per-principal; role strings are tenant-visible until the policy layer.
    expect((await gate.inbox(p)).map((r) => r.id).sort()).toEqual(
      [mine.id, question.id, roleRouted.id].sort(),
    );
    expect((await gate.inbox(p, { kinds: ["question"] })).map((r) => r.id)).toEqual([question.id]);
    expect((await gate.inbox(p, { subjectKinds: ["record_field"] })).map((r) => r.id)).toEqual([
      question.id,
    ]);
    expect(await gate.inbox(p, { kinds: ["notification"] })).toEqual([]);
    // Different tenant sees nothing.
    expect(await gate.inbox(principal(newUlid(), alice))).toEqual([]);
  });

  test("SLA sweep walks the ladder: follow_up → escalate → expire, emitting events", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const gate = createHumanGate(db, spine);
    const tenantId = newUlid();
    const responderId = newUlid();
    const managerId = newUlid();
    const p = principal(tenantId, responderId);

    const created = await gate.request(
      newRequest(tenantId, responderId, {
        routing: {
          assignee: { kind: "principal", id: responderId },
          channelPrefs: ["portal"],
          slaHours: 1,
          escalationPath: [{ kind: "principal", id: managerId }],
          followUpCount: 0,
        },
      }),
    );
    const t0 = Date.parse(created.createdAt);

    // Not due yet — nothing happens.
    expect(await gate.tick(new Date(t0 + 0.5 * HOUR_MS))).toEqual([]);

    // 1st breach: follow up with the current assignee, reschedule one SLA out.
    const first = await gate.tick(new Date(t0 + 2 * HOUR_MS));
    expect(first).toEqual([
      { humanRequestId: created.id, action: "follow_up", at: new Date(t0 + 2 * HOUR_MS).toISOString() },
    ]);
    let [current] = await gate.inbox(p);
    expect(current!.routing.followUpCount).toBe(1);
    expect(Date.parse(current!.routing.nextFollowUpAt!)).toBe(t0 + 3 * HOUR_MS);
    expect(current!.routing.assignee).toEqual({ kind: "principal", id: responderId });

    // 2nd breach: escalate to the next step on the path.
    const second = await gate.tick(new Date(t0 + 4 * HOUR_MS));
    expect(second.map((a) => a.action)).toEqual(["escalate"]);
    [current] = await gate.inbox(principal(tenantId, managerId));
    expect(current!.routing.assignee).toEqual({ kind: "principal", id: managerId });
    expect(current!.routing.followUpCount).toBe(2);

    // 3rd breach: path exhausted — expire (terminal).
    const third = await gate.tick(new Date(t0 + 6 * HOUR_MS));
    expect(third.map((a) => a.action)).toEqual(["expire"]);
    const all = await gate.inbox(principal(tenantId, managerId), { includeResolved: true });
    expect(all[0]!.state).toBe("expired");
    expect(all[0]!.routing.nextFollowUpAt).toBeUndefined();

    // Expired requests cannot be resolved.
    expect(gate.resolve(created.id, resolution(managerId, "approved"), p)).rejects.toThrow(
      IllegalTransitionError,
    );

    // A further sweep owes nothing.
    expect(await gate.tick(new Date(t0 + 100 * HOUR_MS))).toEqual([]);

    const events = await spine.readSince(
      { consumerId: "t", tenantId, afterSeq: 0n },
      { topics: ["humangate.*"] },
    );
    expect(events.map((e) => e.topic)).toEqual([
      "humangate.requested",
      "humangate.follow_up",
      "humangate.escalated",
      "humangate.expired",
    ]);
    expect(events[1]!.payload).toEqual({ followUpCount: 1 });
    expect(events[2]!.payload).toEqual({
      followUpCount: 2,
      assignee: { kind: "principal", id: managerId },
    });
    expect(events[3]!.payload).toEqual({ followUpCount: 2 });
  });

  test("the sweep skips requests without an SLA and ones resolved in the meantime", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const gate = createHumanGate(db, spine);
    const tenantId = newUlid();
    const responderId = newUlid();
    const p = principal(tenantId, responderId);

    const noSla = await gate.request(newRequest(tenantId, responderId)); // no slaHours → no wake
    expect(noSla.routing.nextFollowUpAt).toBeUndefined();

    const withSla = await gate.request(
      newRequest(tenantId, responderId, {
        routing: {
          assignee: { kind: "principal", id: responderId },
          channelPrefs: ["portal"],
          slaHours: 1,
          escalationPath: [],
          followUpCount: 0,
        },
      }),
    );
    await gate.resolve(withSla.id, resolution(responderId, "approved"), p);

    // Both are ineligible: one never had a wake, the other resolved before the sweep.
    expect(await gate.tick(new Date(Date.now() + 48 * HOUR_MS))).toEqual([]);
  });

  test("slaTickSource drives the sweep through the clock's TickSource contract", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const gate = createHumanGate(db, spine);
    const tenantId = newUlid();
    const responderId = newUlid();

    const created = await gate.request(
      newRequest(tenantId, responderId, {
        routing: {
          assignee: { kind: "principal", id: responderId },
          channelPrefs: ["portal"],
          slaHours: 1,
          escalationPath: [],
          followUpCount: 0,
        },
      }),
    );
    const source = slaTickSource(gate);
    expect(source.id).toBe("humangate.sla");
    await source.tick(new Date(Date.parse(created.createdAt) + 2 * HOUR_MS));

    const [after] = await gate.inbox(principal(tenantId, responderId));
    expect(after!.routing.followUpCount).toBe(1);
  });
});

describePg("humangate HTTP routes (integration)", () => {
  beforeEach(async () => {
    await truncateAll(await freshDb());
  });

  async function realApp() {
    const db = await freshDb();
    const spine = createEventSpine(db);
    return buildApp({
      role: "all",
      humanGate: createHumanGate(db, spine),
      workQueue: createWorkQueue(),
      contextStore: createContextStore(),
    });
  }

  function identityHeaders(tenantId: string, principalId: string): Record<string, string> {
    return {
      "x-lithis-tenant": tenantId,
      "x-lithis-principal": principalId,
      "content-type": "application/json",
    };
  }

  const requestBody = {
    kind: "approval",
    subjectKind: "action",
    subjectRef: { kind: "action_intent", id: newUlid() },
    payload: { capability: "gmail.send" },
    summary: "Send the renewal follow-up email to Acme?",
    routing: { assignee: "underwriter", slaHours: 4 },
  };

  test("POST request → GET inbox → POST resolve round-trip", async () => {
    const app = await realApp();
    const headers = identityHeaders(newUlid(), newUlid());

    const createRes = await app.request("/api/humangate/request", {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: string;
      state: string;
      requestedBy: { id: string };
      routing: { nextFollowUpAt?: string; channelPrefs: string[] };
    };
    expect(created.state).toBe("pending");
    expect(created.requestedBy.id).toBe(headers["x-lithis-principal"]!);
    expect(created.routing.nextFollowUpAt).toBeDefined(); // slaHours scheduled the wake
    expect(created.routing.channelPrefs).toEqual(["portal"]); // schema default applied

    const inboxRes = await app.request("/api/humangate/inbox", { headers });
    expect(inboxRes.status).toBe(200);
    expect(((await inboxRes.json()) as { id: string }[]).map((r) => r.id)).toEqual([created.id]);

    const resolveRes = await app.request(`/api/humangate/${created.id}/resolve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ verdict: "approved", comment: "ship it" }),
    });
    expect(resolveRes.status).toBe(200);
    const resolved = (await resolveRes.json()) as {
      state: string;
      resolution: { by: { id: string }; comment: string };
    };
    expect(resolved.state).toBe("approved");
    expect(resolved.resolution.by.id).toBe(headers["x-lithis-principal"]!);
    expect(resolved.resolution.comment).toBe("ship it");

    // Inbox is pending-only by default; includeResolved widens.
    expect((await (await app.request("/api/humangate/inbox", { headers })).json()) as unknown[]).toEqual([]);
    const widened = await app.request("/api/humangate/inbox?includeResolved=true", { headers });
    expect(((await widened.json()) as { state: string }[]).map((r) => r.state)).toEqual(["approved"]);
  });

  test("route errors: 400 invalid body, 400 bad filter, 404 unknown id, 409 double-resolve", async () => {
    const app = await realApp();
    const headers = identityHeaders(newUlid(), newUlid());

    const badBody = await app.request("/api/humangate/request", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "approval" }),
    });
    expect(badBody.status).toBe(400);

    const notJson = await app.request("/api/humangate/request", {
      method: "POST",
      headers,
      body: "not json",
    });
    expect(notJson.status).toBe(400);

    const badFilter = await app.request("/api/humangate/inbox?kinds=nonsense", { headers });
    expect(badFilter.status).toBe(400);

    const missing = await app.request(`/api/humangate/${newUlid()}/resolve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ verdict: "approved", comment: "?" }),
    });
    expect(missing.status).toBe(404);

    const createRes = await app.request("/api/humangate/request", {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });
    const { id } = (await createRes.json()) as { id: string };
    const resolve = (verdict: string) =>
      app.request(`/api/humangate/${id}/resolve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ verdict, comment: "call" }),
      });
    expect((await resolve("denied")).status).toBe(200);
    expect((await resolve("approved")).status).toBe(409);
  });

  test("kinds/subjectKinds query filters narrow the inbox", async () => {
    const app = await realApp();
    const headers = identityHeaders(newUlid(), newUlid());

    await app.request("/api/humangate/request", {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });
    await app.request("/api/humangate/request", {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...requestBody,
        kind: "question",
        subjectKind: "record_field",
        options: ["yes", "no"],
      }),
    });

    const questions = await app.request("/api/humangate/inbox?kinds=question", { headers });
    const got = (await questions.json()) as { kind: string; options?: string[] }[];
    expect(got.length).toBe(1);
    expect(got[0]!.kind).toBe("question");
    expect(got[0]!.options).toEqual(["yes", "no"]);

    const none = await app.request("/api/humangate/inbox?subjectKinds=sor_migration", { headers });
    expect((await none.json()) as unknown[]).toEqual([]);
  });
});

describe("humangate HTTP routes (db-less)", () => {
  // Complements apps/server/test/api.test.ts: identity errors still win over 503.
  const dblessApp = buildApp({ role: "all", workQueue: createWorkQueue(), contextStore: createContextStore() });

  test("resolve route answers 503 after identity passes, 400 without identity", async () => {
    const noIdentity = await dblessApp.request(`/api/humangate/${newUlid()}/resolve`, {
      method: "POST",
    });
    expect(noIdentity.status).toBe(400);

    const withIdentity = await dblessApp.request(`/api/humangate/${newUlid()}/resolve`, {
      method: "POST",
      headers: { "x-lithis-tenant": newUlid(), "x-lithis-principal": newUlid() },
      body: JSON.stringify({ verdict: "approved", comment: "?" }),
    });
    expect(withIdentity.status).toBe(503);
  });
});
