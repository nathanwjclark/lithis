import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUlid } from "@lithis/core";
import type { Connection, Event, HumanRequest } from "@lithis/core";
import { createSlackConnector } from "@lithis/connector-slack";
import { buildApp } from "../../src/api";
import {
  createConnectionRegistry,
  createConnectorRuntime,
  createCredentialDirectory,
} from "../../src/connections";
import type { ConnectionRegistry, ConnectorRuntime } from "../../src/connections";
import { createContextStore, createLocalBlobStorage } from "../../src/context";
import { createCustody } from "../../src/custody";
import { attachDeliverySubscriptions, createDelivery } from "../../src/delivery";
import type { DeliveryRuntime } from "../../src/delivery";
import { createHumanGate } from "../../src/humangate";
import type { HumanGate, NewHumanRequest } from "../../src/humangate";
import { createEventSpine } from "../../src/spine";
import type { EventSpineRuntime } from "../../src/spine";
import { describePg, freshDb, truncateAll } from "../helpers/pg";

/**
 * The P6-deliver acceptance, end to end against real Postgres: a HumanRequest
 * preferring slack becomes a Block Kit evidence card posted through the REAL
 * slack connector (fixture fetch — no network) under REAL custody-brokered
 * auth; the returned "channel:ts" persists as the thread anchor; an inbound
 * Slack reply in that thread rides ingestSlackEvent → quarantined doc →
 * conversation.message → the reply subscriber → humanGate.resolve. Real
 * spine dispatcher, real humangate, real delivery ledger throughout.
 */

const CARD_CHANNEL = "C0100CARDS";
const BOT_TOKEN = "xoxb-fixture-bot-token";

// ── fixture slack transport (fixture data in tests — exactly where it belongs) ─

interface PostedMessage {
  authorization: string | null;
  body: { channel: string; text?: string; blocks?: unknown[]; thread_ts?: string };
  ts: string;
}

interface FakeSlack {
  fetch: typeof globalThis.fetch;
  posted: PostedMessage[];
  failNext: { code: string } | undefined;
}

function fakeSlack(): FakeSlack {
  let tsCounter = 0;
  const fake: FakeSlack = { posted: [], failNext: undefined, fetch: undefined as never };
  fake.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = url.pathname.split("/").pop();
    if (method !== "chat.postMessage") {
      throw new Error(`fake slack: unexpected method ${method}`);
    }
    if (fake.failNext !== undefined) {
      const code = fake.failNext.code;
      fake.failNext = undefined;
      return Response.json({ ok: false, error: code });
    }
    const body = JSON.parse(String(init?.body)) as PostedMessage["body"];
    tsCounter += 1;
    const ts = `1718000000.${String(tsCounter).padStart(6, "0")}`;
    fake.posted.push({
      authorization: new Headers(init?.headers).get("authorization"),
      body,
      ts,
    });
    return Response.json({ ok: true, channel: body.channel, ts });
  }) as typeof globalThis.fetch;
  return fake;
}

// ── shared rig ───────────────────────────────────────────────────────────────

interface Rig {
  spine: EventSpineRuntime;
  gate: HumanGate;
  delivery: DeliveryRuntime;
  registry: ConnectionRegistry;
  runtime: ConnectorRuntime;
  connection: Connection;
  slack: FakeSlack;
  tenantId: string;
  stop(): Promise<void>;
}

async function buildRig(opts: { slackChannel?: string | undefined } = {}): Promise<Rig> {
  const db = await freshDb();
  const spine = createEventSpine(db);
  const gate = createHumanGate(db, spine);
  const tenantId = newUlid();

  const credentials = createCredentialDirectory(db, spine);
  const custody = createCustody({
    db,
    spine,
    credentials,
    backend: {
      async getSecret(ref: string): Promise<string> {
        if (ref !== "env-file:SLACK_BOT_TOKEN") throw new Error(`no secret for ${ref}`);
        return BOT_TOKEN;
      },
    },
  });
  const auth = {
    getAuth: async (connection: Connection) => {
      const brokered = await custody.issueFor(connection.credentialRef, connection.tenantId, {
        kind: "connection" as const,
        id: connection.id,
      });
      return { kind: brokered.kind, token: brokered.brokerToken, expiresAt: brokered.expiresAt };
    },
    redeem: async (brokerToken: string) => (await custody.redeem(brokerToken)).secret,
  };

  const slack = fakeSlack();
  const runtime = createConnectorRuntime(auth);
  runtime.register((provider) => createSlackConnector(provider, { fetch: slack.fetch }));
  const registry = createConnectionRegistry(db, spine, { probes: runtime });

  const credential = await credentials.create({
    tenantId,
    kind: "oauth_token",
    custodyBackendRef: "env-file:SLACK_BOT_TOKEN",
  });
  const connection = await registry.register({
    tenantId,
    connectorSlug: "slack",
    displayName: "Fixture workspace",
    credentialRef: credential.id,
    scopes: ["chat:write"],
  });

  const contextStore = createContextStore(db, spine, {
    blobs: createLocalBlobStorage(mkdtempSync(join(tmpdir(), "lithis-delivery-blobs-"))),
  });
  const delivery = createDelivery({
    db,
    spine,
    humanGate: gate,
    runtime,
    auth,
    connections: registry,
    contextStore,
    ...("slackChannel" in opts ? {} : { slackChannel: CARD_CHANNEL }),
    ...(opts.slackChannel !== undefined ? { slackChannel: opts.slackChannel } : {}),
  });
  const subscriptions = attachDeliverySubscriptions(spine, delivery);
  spine.startDispatcher({ intervalMs: 25 });

  return {
    spine,
    gate,
    delivery,
    registry,
    runtime,
    connection,
    slack,
    tenantId,
    stop: async () => {
      for (const s of subscriptions) await s.close();
      await spine.stopDispatcher();
    },
  };
}

function newRequest(tenantId: string, overrides: Partial<NewHumanRequest> = {}): NewHumanRequest {
  return {
    kind: "approval",
    subjectKind: "action",
    subjectRef: { kind: "action_intent", id: newUlid() },
    payload: { capability: "slack.chat.write" },
    evidenceIds: [newUlid()],
    summary: "Send the renewal follow-up email to Acme?",
    routing: {
      assignee: "underwriter",
      channelPrefs: ["slack", "portal"],
      escalationPath: [],
      followUpCount: 0,
    },
    requestedBy: { kind: "principal", id: newUlid() },
    tenantId,
    ...overrides,
  };
}

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function eventsFor(rig: Rig, topics: string[]): Promise<Event[]> {
  return rig.spine.readSince(
    { consumerId: "assert", tenantId: rig.tenantId, afterSeq: 0n },
    { topics },
    500,
  );
}

function reply(channel: string, threadTs: string, text: string, user = "U0200ALICE") {
  return {
    type: "event_callback",
    team_id: "T0100",
    event: {
      type: "message",
      channel,
      ts: `1718000100.${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`,
      thread_ts: threadTs,
      text,
      user,
    },
  };
}

describePg("delivery (integration)", () => {
  let rig: Rig;
  beforeEach(async () => {
    await truncateAll(await freshDb());
  });
  afterEach(async () => {
    await rig.stop();
  });

  test("ACCEPTANCE: a humangate request is approved from Slack, end to end", async () => {
    rig = await buildRig();
    const created = await rig.gate.request(newRequest(rig.tenantId));

    // 1. The card goes out through the real connector under brokered auth.
    const posted = await until(async () => rig.slack.posted[0]);
    expect(posted.authorization).toBe(`Bearer ${BOT_TOKEN}`); // custody redeemed, connector never saw the credential row
    expect(posted.body.channel).toBe(CARD_CHANNEL);
    expect(posted.body.text).toBe(created.summary);
    expect(JSON.stringify(posted.body.blocks)).toContain(created.evidenceIds[0]!);
    expect(posted.body.thread_ts).toBeUndefined();

    // 2. The delivery ledger holds the channel:ts anchor + the sent event rode the outbox.
    const anchor = `${CARD_CHANNEL}:${posted.ts}`;
    const record = await until(() => rig.delivery.findByAnchor(rig.tenantId, anchor));
    expect(record.kind).toBe("human_request");
    expect(record.humanRequestId).toBe(created.id);
    expect(record.connectionId).toBe(rig.connection.id);
    expect(record.status).toBe("sent");
    const sent = await eventsFor(rig, ["delivery.sent"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({
      channel: "slack",
      kind: "human_request",
      externalId: anchor,
      humanRequestId: created.id,
    });

    // 3. A human replies "approve" in the card's thread.
    const outcome = await rig.delivery.ingestSlackEvent(
      rig.connection,
      reply(CARD_CHANNEL, posted.ts, "approve — numbers check out"),
    );
    expect(outcome.ingested).toBe(true);
    expect(outcome.docId).toBeDefined();

    // 4. The reply subscriber resolves the request.
    const resolved = await until(async () => {
      const r = await rig.gate.get(created.id, rig.tenantId);
      return r?.state === "approved" ? r : undefined;
    });
    expect(resolved.resolution?.verdict).toBe("approved");
    expect(resolved.resolution?.comment).toBe(
      "approve — numbers check out (via slack reply from U0200ALICE)",
    );
    expect(resolved.resolution?.by).toEqual({ kind: "connection", id: rig.connection.id });

    // 5. The whole story is on the spine: card sent, message ingested, request resolved.
    const conversation = await eventsFor(rig, ["conversation.message"]);
    expect(conversation).toHaveLength(1);
    expect(conversation[0]!.payload).toMatchObject({
      direction: "inbound",
      channel: "slack",
      threadExternalId: anchor,
      authorExternalId: "U0200ALICE",
      docId: outcome.docId,
    });
    const docs = await eventsFor(rig, ["context.doc.created"]);
    expect(docs.length).toBeGreaterThanOrEqual(1); // the reply landed as a quarantined doc
    const gateEvents = await eventsFor(rig, ["humangate.resolved"]);
    expect(gateEvents).toHaveLength(1);
    expect(gateEvents[0]!.payload).toEqual({ verdict: "approved" });
  });

  test("deny works, chatter and bot posts never resolve, duplicates are idempotent", async () => {
    rig = await buildRig();
    const created = await rig.gate.request(newRequest(rig.tenantId));
    const posted = await until(async () => rig.slack.posted[0]);

    // Chatter in the thread does not resolve.
    await rig.delivery.ingestSlackEvent(rig.connection, reply(CARD_CHANNEL, posted.ts, "what is this about?"));
    // A bot post (our own card echo) is not even ingested.
    const botEcho = reply(CARD_CHANNEL, posted.ts, "approve");
    (botEcho.event as { bot_id?: string }).bot_id = "B0100BOT";
    const botOutcome = await rig.delivery.ingestSlackEvent(rig.connection, botEcho);
    expect(botOutcome.ingested).toBe(false);

    // The same human reply delivered twice (Socket Mode redelivery) ingests once.
    const deny = reply(CARD_CHANNEL, posted.ts, "deny — wrong quote attached", "U0300BOB");
    expect((await rig.delivery.ingestSlackEvent(rig.connection, deny)).ingested).toBe(true);
    const dup = await rig.delivery.ingestSlackEvent(rig.connection, deny);
    expect(dup.ingested).toBe(false);
    expect(dup.reason).toContain("already ingested");

    const resolved = await until(async () => {
      const r = await rig.gate.get(created.id, rig.tenantId);
      return r?.state !== "pending" ? r : undefined;
    });
    expect(resolved.state).toBe("denied");
    expect(resolved.resolution?.comment).toBe(
      "deny — wrong quote attached (via slack reply from U0300BOB)",
    );

    // Only ONE humangate.resolved despite chatter + duplicate.
    expect(await eventsFor(rig, ["humangate.resolved"])).toHaveLength(1);
    // Chatter + deny = two conversation.message events (bot echo and dup were skipped).
    expect(await eventsFor(rig, ["conversation.message"])).toHaveLength(2);
  });

  test("question + notification vocabulary: answer/ack resolve from the thread", async () => {
    rig = await buildRig();
    const question = await rig.gate.request(
      newRequest(rig.tenantId, {
        kind: "question",
        subjectKind: "record_field",
        summary: "Which tier did Acme ask for?",
        options: ["Standard tier", "Premium tier"],
      }),
    );
    const qCard = await until(async () => rig.slack.posted[0]);
    await rig.delivery.ingestSlackEvent(rig.connection, reply(CARD_CHANNEL, qCard.ts, "answer: Premium tier"));
    const answered = await until(async () => {
      const r = await rig.gate.get(question.id, rig.tenantId);
      return r?.state === "answered" ? r : undefined;
    });
    expect(answered.resolution?.comment).toContain("Premium tier");

    const notification = await rig.gate.request(
      newRequest(rig.tenantId, { kind: "notification", summary: "Quote pack was regenerated." }),
    );
    const nCard = await until(async () => rig.slack.posted[1]);
    await rig.delivery.ingestSlackEvent(rig.connection, reply(CARD_CHANNEL, nCard.ts, "ack"));
    const acked = await until(async () => {
      const r = await rig.gate.get(notification.id, rig.tenantId);
      return r?.state === "acknowledged" ? r : undefined;
    });
    expect(acked.resolution?.verdict).toBe("acknowledged");
  });

  test("SLA follow-up posts a nudge INTO the original card's thread", async () => {
    rig = await buildRig();
    const created = await rig.gate.request(
      newRequest(rig.tenantId, {
        routing: {
          assignee: "underwriter",
          channelPrefs: ["slack"],
          slaHours: 1,
          escalationPath: [],
          followUpCount: 0,
        },
      }),
    );
    const card = await until(async () => rig.slack.posted[0]);

    await rig.gate.tick(new Date(Date.parse(created.createdAt) + 2 * 3_600_000));

    const nudge = await until(async () => rig.slack.posted[1]);
    expect(nudge.body.thread_ts).toBe(card.ts); // threaded on the original card
    expect(nudge.body.text).toContain("1st follow-up");
    const sent = await until(async () => {
      const events = await eventsFor(rig, ["delivery.sent"]);
      return events.length === 2 ? events : undefined;
    });
    expect(sent[1]!.payload).toMatchObject({ kind: "nudge", humanRequestId: created.id });
  });

  test("portal-only requests never touch slack; failures are recorded, not dropped", async () => {
    rig = await buildRig();
    // portal-only: no card.
    await rig.gate.request(
      newRequest(rig.tenantId, {
        routing: { assignee: "underwriter", channelPrefs: ["portal"], escalationPath: [], followUpCount: 0 },
      }),
    );
    // slack-preferring, but Slack rejects the post (bad channel).
    rig.slack.failNext = { code: "channel_not_found" };
    const failing = await rig.gate.request(newRequest(rig.tenantId));

    const failedEvents = await until(async () => {
      const events = await eventsFor(rig, ["delivery.failed"]);
      return events.length === 1 ? events : undefined;
    });
    expect(failedEvents[0]!.payload).toMatchObject({
      channel: "slack",
      kind: "human_request",
      humanRequestId: failing.id,
    });
    expect((failedEvents[0]!.payload as { reason: string }).reason).toContain("channel_not_found");
    expect(rig.slack.posted).toHaveLength(0); // the portal-only request never left the building
    expect(await eventsFor(rig, ["delivery.sent"])).toHaveLength(0);
  });

  test("unconfigured SLACK_DELIVERY_CHANNEL degrades honestly to delivery.failed", async () => {
    rig = await buildRig({ slackChannel: undefined });
    await rig.gate.request(newRequest(rig.tenantId));
    const failed = await until(async () => {
      const events = await eventsFor(rig, ["delivery.failed"]);
      return events.length === 1 ? events : undefined;
    });
    expect((failed[0]!.payload as { reason: string }).reason).toContain("SLACK_DELIVERY_CHANNEL");
    expect(rig.slack.posted).toHaveLength(0);
  });

  test("HTTP ingress: url_verification handshake + reply-through-route resolves", async () => {
    rig = await buildRig();
    const app = buildApp({
      role: "all",
      delivery: rig.delivery,
      slackConnectionFor: async (tenantId) =>
        (await rig.registry.findByConnector("slack", tenantId))[0],
      contextStore: {
        putBlob: () => Promise.reject(new Error("unused")),
        readBlob: () => Promise.reject(new Error("unused")),
        ingestDoc: () => Promise.reject(new Error("unused")),
        distill: () => Promise.reject(new Error("unused")),
        search: () => Promise.reject(new Error("unused")),
        paths: () => Promise.reject(new Error("unused")),
      },
    });
    const headers = {
      "x-lithis-tenant": rig.tenantId,
      "x-lithis-principal": newUlid(),
      "content-type": "application/json",
    };

    // Slack's endpoint handshake.
    const challenge = await app.request("/api/delivery/slack/events", {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "url_verification", challenge: "c0ffee" }),
    });
    expect(challenge.status).toBe(200);
    expect(await challenge.json()).toEqual({ challenge: "c0ffee" });

    // No identity → 400; foreign tenant without a slack connection → 409.
    expect(
      (await app.request("/api/delivery/slack/events", { method: "POST", body: "{}" })).status,
    ).toBe(400);
    const foreign = await app.request("/api/delivery/slack/events", {
      method: "POST",
      headers: { ...headers, "x-lithis-tenant": newUlid() },
      body: JSON.stringify(reply("C1", "1.2", "approve")),
    });
    expect(foreign.status).toBe(409);

    // The real flow: card out, reply in via the route, request approved.
    const created = await rig.gate.request(newRequest(rig.tenantId));
    const posted = await until(async () => rig.slack.posted[0]);
    const ingress = await app.request("/api/delivery/slack/events", {
      method: "POST",
      headers,
      body: JSON.stringify(reply(CARD_CHANNEL, posted.ts, "approve via http")),
    });
    expect(ingress.status).toBe(202);
    const resolved = await until(async () => {
      const r = await rig.gate.get(created.id, rig.tenantId);
      return r?.state === "approved" ? r : undefined;
    });
    expect(resolved.resolution?.comment).toContain("approve via http");
  });
});
