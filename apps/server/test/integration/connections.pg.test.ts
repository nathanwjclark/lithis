import { beforeEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { newUlid, nowIso } from "@lithis/core";
import type { Connection, Event, PrincipalContext, Ulid } from "@lithis/core";
import { defineConnector } from "@lithis/sdk/connectors";
import type {
  BrokeredAuth,
  ConnectorHooks,
  ConnectorManifest,
  IngestSink,
  NewDocInput,
} from "@lithis/sdk/connectors";
import {
  createConnectionRegistry,
  createConnectorRuntime,
  createCredentialDirectory,
  createFeedExpectationTickSource,
  createSyncTickSource,
} from "../../src/connections";
import type { ConnectorAuthProvider, ConnectorRuntime } from "../../src/connections";
import { createCustody, createEnvFileBackend } from "../../src/custody";
import { createEventSpine } from "../../src/spine";
import type { EventSpine } from "../../src/spine";
import { describePg, freshDb, truncateAll } from "../helpers/pg";

const FIXTURE_SECRETS = fileURLToPath(new URL("../fixtures/custody.secrets.env", import.meta.url));
const FIXTURE_SECRET_VALUE = "xoxb-fixture-not-a-real-secret-0001";
const FEED = "fake-slack:messages";

const manifest: ConnectorManifest = {
  slug: "fake-slack",
  displayName: "Fake Slack",
  authKind: "api_key",
  feeds: [{ key: FEED, description: "test feed", docTypes: ["message"] }],
  actions: [],
  scopes: [],
};

function docInput(connection: Connection): NewDocInput {
  return {
    type: "message",
    slug: `msg-${newUlid().toLowerCase()}`,
    title: "A synced message",
    bodyBlobId: newUlid(),
    frontmatter: {},
    origin: {
      by: { kind: "connection", id: connection.id },
      method: "code",
      trust: "partner",
      at: nowIso(),
    },
  };
}

function collectingSink(): { sink: IngestSink; ingested: NewDocInput[] } {
  const ingested: NewDocInput[] = [];
  return {
    sink: {
      putBlob: async () => ({ kind: "blob", id: newUlid() }),
      ingestDoc: async (input) => {
        ingested.push(input);
        return { kind: "doc", id: newUlid() };
      },
    },
    ingested,
  };
}

function principal(tenantId: Ulid): PrincipalContext {
  return { tenantId, principalId: newUlid(), kind: "human" };
}

async function topicEvents(spine: EventSpine, tenantId: Ulid, topic: string): Promise<Event[]> {
  return spine.readSince({ consumerId: "t", tenantId, afterSeq: 0n }, { topics: [topic] }, 500);
}

interface Stack {
  db: Awaited<ReturnType<typeof freshDb>>;
  spine: EventSpine;
  credentials: ReturnType<typeof createCredentialDirectory>;
  runtime: ConnectorRuntime;
  registry: ReturnType<typeof createConnectionRegistry>;
  provider: ConnectorAuthProvider;
}

async function buildStack(): Promise<Stack> {
  const db = await freshDb();
  const spine = createEventSpine(db);
  const credentials = createCredentialDirectory(db, spine);
  const custody = createCustody({
    db,
    spine,
    credentials,
    backend: createEnvFileBackend(FIXTURE_SECRETS),
  });
  // Mirrors the main.ts wiring: custody issues for the CONNECTION as actor,
  // redeem exchanges the opaque token for material at call time.
  const provider: ConnectorAuthProvider = {
    getAuth: async (connection) => {
      const auth = await custody.issueFor(connection.credentialRef, connection.tenantId, {
        kind: "connection",
        id: connection.id,
      });
      return { kind: auth.kind, token: auth.brokerToken, expiresAt: auth.expiresAt };
    },
    redeem: async (brokerToken) => (await custody.redeem(brokerToken)).secret,
  };
  const runtime = createConnectorRuntime(provider);
  const registry = createConnectionRegistry(db, spine, { probes: runtime });
  return { db, spine, credentials, runtime, registry, provider };
}

async function registerConnection(
  stack: Stack,
  tenantId: Ulid,
  extras?: Parameters<Stack["registry"]["register"]>[0]["feedExpectations"],
): Promise<Connection> {
  const credential = await stack.credentials.create({
    tenantId,
    kind: "api_key",
    custodyBackendRef: "env-file:FAKE_SLACK_TOKEN",
  });
  return await stack.registry.register({
    tenantId,
    connectorSlug: "fake-slack",
    displayName: "Fake Slack",
    credentialRef: credential.id,
    scopes: [],
    ...(extras !== undefined ? { feedExpectations: extras } : {}),
  });
}

describePg("ConnectionRegistry + sync/expectation TickSources (integration)", () => {
  beforeEach(async () => {
    await truncateAll(await freshDb());
  });

  test("register round-trips, arms feed expectations, and emits connection.registered", async () => {
    const stack = await buildStack();
    const tenantId = newUlid();
    const connection = await registerConnection(stack, tenantId, [
      { key: FEED, expectCadence: "* * * * *", graceMinutes: 5, onMiss: "flag" },
    ]);
    expect(connection.status).toBe("healthy");
    expect(connection.syncState).toEqual({ cursorsByFeed: {} });

    const listed = await stack.registry.list(principal(tenantId));
    expect(listed).toEqual([connection]);
    // tenant scoping
    expect(await stack.registry.list(principal(newUlid()))).toEqual([]);

    const expectations: { key: string; missed_count: number }[] = await stack.db.sql`
      select key, missed_count from connections.feed_expectations
      where connection_id = ${connection.id}`;
    expect(expectations).toEqual([{ key: FEED, missed_count: 0 }]);

    const events = await topicEvents(stack.spine, tenantId, "connection.registered");
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toEqual({ connectorSlug: "fake-slack", displayName: "Fake Slack" });
  });

  test("ACCEPTANCE: scheduled sync through a fake connector persists the cursor and emits connector.sync.completed", async () => {
    const stack = await buildStack();
    const tenantId = newUlid();

    const seenCursors: (string | null)[] = [];
    const seenAuths: BrokeredAuth[] = [];
    const seenSecrets: string[] = [];
    // Registered THROUGH the seam, as the C-* phases will: a factory that
    // receives the ConnectorAuthProvider and pulls auth from custody per sync.
    stack.runtime.register((auth) =>
      defineConnector(manifest, {
        sync: async (connection, _feed, cursor, sink) => {
          const brokered = await auth.getAuth(connection);
          seenAuths.push(brokered);
          seenSecrets.push(await auth.redeem(brokered.token!));
          seenCursors.push(cursor);
          await sink.ingestDoc(docInput(connection));
          return cursor === null ? "cursor-1" : "cursor-2";
        },
        act: async () => ({ ok: true }),
        health: async () => ({ ok: true }),
      }),
    );
    const connection = await registerConnection(stack, tenantId);

    const { sink, ingested } = collectingSink();
    const source = createSyncTickSource({
      db: stack.db,
      spine: stack.spine,
      runtime: stack.runtime,
      sink,
      intervalMinutes: 5,
    });
    await source.tick(new Date());

    const [synced] = await stack.registry.list(principal(tenantId));
    expect(synced!.syncState.cursorsByFeed[FEED]).toBe("cursor-1");
    expect(synced!.syncState.lastSyncAt).toBeDefined();
    expect(synced!.syncState.lastError).toBeUndefined();
    expect(synced!.status).toBe("healthy");
    expect(synced!.health.lastOkAt).toBeDefined();
    expect(ingested.length).toBe(1);

    const completed = await topicEvents(stack.spine, tenantId, "connector.sync.completed");
    expect(completed.length).toBe(1);
    expect(completed[0]!.payload).toEqual({ feed: FEED, newDocs: 1, cursor: "cursor-1" });

    // Auth flowed from custody as an opaque BrokeredAuth; the secret only ever
    // came back through redeem(), server-side.
    expect(seenAuths.length).toBe(1);
    expect(seenAuths[0]!.token).toStartWith("bkr_");
    expect(JSON.stringify(seenAuths)).not.toContain(FIXTURE_SECRET_VALUE);
    expect(seenSecrets).toEqual([FIXTURE_SECRET_VALUE]);
    const issued = await topicEvents(stack.spine, tenantId, "custody.credential.brokered");
    expect(issued.length).toBe(1);
    expect(issued[0]!.actor).toEqual({ kind: "connection", id: connection.id });

    // Within the interval the connection is not due — nothing re-syncs.
    await source.tick(new Date());
    expect(seenCursors).toEqual([null]);

    // Once due again, the PERSISTED cursor feeds the next incremental sync.
    const eager = createSyncTickSource({
      db: stack.db,
      spine: stack.spine,
      runtime: stack.runtime,
      sink,
      intervalMinutes: 0,
    });
    await eager.tick(new Date());
    expect(seenCursors).toEqual([null, "cursor-1"]);
    const [resynced] = await stack.registry.list(principal(tenantId));
    expect(resynced!.syncState.cursorsByFeed[FEED]).toBe("cursor-2");
    expect((await topicEvents(stack.spine, tenantId, "connector.sync.completed")).length).toBe(2);
  });

  test("sync failure is recorded honestly and the health transition emits exactly once", async () => {
    const stack = await buildStack();
    const tenantId = newUlid();
    let failing = true;
    stack.runtime.register(
      defineConnector(manifest, {
        sync: async (_c, _f, cursor) => {
          if (failing) throw new Error("slack said 429");
          return "cursor-after-recovery";
        },
        act: async () => ({ ok: true }),
        health: async () => ({ ok: true }),
      }),
    );
    await registerConnection(stack, tenantId);

    const { sink } = collectingSink();
    const source = createSyncTickSource({
      db: stack.db,
      spine: stack.spine,
      runtime: stack.runtime,
      sink,
      intervalMinutes: 0,
    });

    await source.tick(new Date());
    let [conn] = await stack.registry.list(principal(tenantId));
    expect(conn!.status).toBe("degraded");
    expect(conn!.syncState.lastError).toContain("slack said 429");
    expect(conn!.health.lastError).toContain("slack said 429");
    expect((await topicEvents(stack.spine, tenantId, "connector.sync.completed")).length).toBe(0);

    // Second failing tick: still degraded — NO second transition event.
    await source.tick(new Date());
    const changed = await topicEvents(stack.spine, tenantId, "connection.health.changed");
    expect(changed.length).toBe(1);
    expect(changed[0]!.payload).toMatchObject({ from: "healthy", to: "degraded" });

    // Recovery: next successful sync clears the error and transitions back.
    failing = false;
    await source.tick(new Date());
    [conn] = await stack.registry.list(principal(tenantId));
    expect(conn!.status).toBe("healthy");
    expect(conn!.syncState.lastError).toBeUndefined();
    expect(conn!.syncState.cursorsByFeed[FEED]).toBe("cursor-after-recovery");
    const changedAfter = await topicEvents(stack.spine, tenantId, "connection.health.changed");
    expect(changedAfter.length).toBe(2);
    expect(changedAfter[1]!.payload).toMatchObject({ from: "degraded", to: "healthy" });
  });

  test("a connection whose connector is not registered fails its sync honestly", async () => {
    const stack = await buildStack();
    const tenantId = newUlid();
    await registerConnection(stack, tenantId); // nothing registered in the runtime
    const { sink } = collectingSink();
    await createSyncTickSource({
      db: stack.db,
      spine: stack.spine,
      runtime: stack.runtime,
      sink,
      intervalMinutes: 0,
    }).tick(new Date());
    const [conn] = await stack.registry.list(principal(tenantId));
    expect(conn!.status).toBe("degraded");
    expect(conn!.syncState.lastError).toContain("no connector registered for slug 'fake-slack'");
  });

  test("ACCEPTANCE: a missed feed emits feed.expectation.missed exactly once and recovers on recordFeedSeen", async () => {
    const stack = await buildStack();
    const tenantId = newUlid();
    const connection = await registerConnection(stack, tenantId, [
      { key: FEED, expectCadence: "* * * * *", graceMinutes: 0, onMiss: "flag" },
    ]);
    const source = createFeedExpectationTickSource(stack.db, stack.spine);
    const missedEvents = (): Promise<Event[]> =>
      topicEvents(stack.spine, tenantId, "feed.expectation.missed");

    // Pin the window via the public heartbeat API.
    await stack.registry.recordFeedSeen(connection.id, FEED, "2026-01-01T00:00:00.000Z");

    // One elapsed fire (00:01) → exactly one miss event…
    await source.tick(new Date("2026-01-01T00:01:10Z"));
    expect((await missedEvents()).length).toBe(1);
    expect((await missedEvents())[0]!.payload).toEqual({ key: FEED, missedCount: 1 });

    // …and re-ticking the same window emits NOTHING more.
    await source.tick(new Date("2026-01-01T00:01:10Z"));
    await source.tick(new Date("2026-01-01T00:01:50Z"));
    expect((await missedEvents()).length).toBe(1);

    // The NEXT missed occurrence is a new announcement.
    await source.tick(new Date("2026-01-01T00:02:10Z"));
    expect((await missedEvents()).length).toBe(2);
    expect((await missedEvents())[1]!.payload).toEqual({ key: FEED, missedCount: 2 });

    // The feed arrives again: grace window resets, recovery is evented once.
    await stack.registry.recordFeedSeen(connection.id, FEED, "2026-01-01T00:02:30.000Z");
    const recovered = await topicEvents(stack.spine, tenantId, "feed.expectation.recovered");
    expect(recovered.length).toBe(1);
    expect(recovered[0]!.payload).toEqual({ key: FEED, missedCount: 2 });
    await source.tick(new Date("2026-01-01T00:02:50Z"));
    expect((await missedEvents()).length).toBe(2); // recovered — no false miss

    // …but the watchdog is re-armed: going quiet again misses again.
    await source.tick(new Date("2026-01-01T00:03:50Z"));
    expect((await missedEvents()).length).toBe(3);
    expect((await missedEvents())[2]!.payload).toEqual({ key: FEED, missedCount: 1 });

    // A routine heartbeat with no outstanding miss is NOT an event.
    await stack.registry.recordFeedSeen(connection.id, FEED, "2026-01-01T00:04:30.000Z");
    await stack.registry.recordFeedSeen(connection.id, FEED, "2026-01-01T00:05:00.000Z");
    expect((await topicEvents(stack.spine, tenantId, "feed.expectation.recovered")).length).toBe(2);
  });

  test("recordFeedSeen on an unknown feed key is a loud error", async () => {
    const stack = await buildStack();
    const connection = await registerConnection(stack, newUlid());
    expect(stack.registry.recordFeedSeen(connection.id, "never-armed", nowIso())).rejects.toThrow(
      /no feed expectation 'never-armed'/,
    );
  });

  test("registry.health probes through the runtime and emits only on transitions", async () => {
    const stack = await buildStack();
    const tenantId = newUlid();
    let probeResult: { ok: boolean; error?: string } = { ok: false, error: "token revoked" };
    stack.runtime.register(
      defineConnector(manifest, {
        sync: async () => "c",
        act: async () => ({ ok: true }),
        health: async () => probeResult,
      }),
    );
    const connection = await registerConnection(stack, tenantId);

    const degraded = await stack.registry.health(connection.id);
    expect(degraded.lastError).toBe("token revoked");
    let changed = await topicEvents(stack.spine, tenantId, "connection.health.changed");
    expect(changed.length).toBe(1);
    expect(changed[0]!.payload).toEqual({ from: "healthy", to: "degraded", error: "token revoked" });

    // Same outcome again → no new event.
    await stack.registry.health(connection.id);
    changed = await topicEvents(stack.spine, tenantId, "connection.health.changed");
    expect(changed.length).toBe(1);

    probeResult = { ok: true };
    const healthy = await stack.registry.health(connection.id);
    expect(healthy.lastOkAt).toBeDefined();
    expect(healthy.lastError).toBeUndefined();
    changed = await topicEvents(stack.spine, tenantId, "connection.health.changed");
    expect(changed.length).toBe(2);
    expect(changed[1]!.payload).toEqual({ from: "degraded", to: "healthy" });
  });

  test("default health probe is honest: derived from the last sync outcome; disabled is sticky", async () => {
    const stack = await buildStack();
    const tenantId = newUlid();
    const connection = await registerConnection(stack, tenantId); // no connector in the runtime

    // Nothing has failed yet → healthy, no transition event.
    await stack.registry.health(connection.id);
    expect((await topicEvents(stack.spine, tenantId, "connection.health.changed")).length).toBe(0);

    // A failed sync (unregistered connector) leaves lastError → probe stays degraded.
    const { sink } = collectingSink();
    await createSyncTickSource({
      db: stack.db,
      spine: stack.spine,
      runtime: stack.runtime,
      sink,
      intervalMinutes: 0,
    }).tick(new Date());
    const afterFailure = await stack.registry.health(connection.id);
    expect(afterFailure.lastError).toContain("no connector registered");
    // one event from the sync transition, none extra from the identical probe
    expect((await topicEvents(stack.spine, tenantId, "connection.health.changed")).length).toBe(1);

    // Disabled connections are never probed back to life.
    await stack.db.sql`
      update connections.connections set status = 'disabled' where id = ${connection.id}`;
    await stack.registry.health(connection.id);
    const [conn] = await stack.registry.list(principal(tenantId));
    expect(conn!.status).toBe("disabled");
    expect((await topicEvents(stack.spine, tenantId, "connection.health.changed")).length).toBe(1);
  });
});
