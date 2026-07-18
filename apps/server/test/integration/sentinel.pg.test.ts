import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { agentCharterSchema, newUlid } from "@lithis/core";
import type { Principal } from "@lithis/core";
import { createAgentsRuntime } from "../../src/agents";
import type { AgentsRuntime } from "../../src/agents";
import type { CompleteFn, ModelTurn } from "../../src/agents/executor";
import { createContextStore, createLocalBlobStorage } from "../../src/context";
import type { ContextStore } from "../../src/context";
import type { Db } from "../../src/db";
import { createHumanGate } from "../../src/humangate";
import { createIdentityService } from "../../src/iam";
import type { IdentityService } from "../../src/iam";
import {
  attachSentinel,
  createRaiseFindingTool,
  createWatcherHost,
  defaultWatcherCharters,
  watcherFindingPayloadSchema,
} from "../../src/sentinel";
import type { WatcherHost } from "../../src/sentinel";
import { createEventSpine } from "../../src/spine";
import type { EventSpineRuntime } from "../../src/spine";
import { createWorkQueue } from "../../src/work";
import type { WorkQueue } from "../../src/work";
import { describePg, freshDb, truncateAll } from "../helpers/pg";

/**
 * P13 acceptance — the sentinel loop end-to-end over real Postgres: the
 * watcher fleet mints idempotently; a concerning conversation.message rides
 * the bridge into a welfare-watcher WorkItem, the resident host works it with
 * a scripted model, and raise_finding lands a confidential
 * HumanRequest{watcher_finding} (the finding card then rides the EXISTING
 * delivery.cards consumer — zero sentinel-specific delivery code).
 */

function toolUseTurn(name: string, input: unknown): ModelTurn {
  return {
    content: [
      { type: "tool_use", id: `toolu_${newUlid()}`, name, input } as Anthropic.Messages.ToolUseBlock,
    ],
    stopReason: "tool_use",
    usage: { inputTokens: 1_000, outputTokens: 500 },
  };
}

/** Consume scripted turns in order; throw when the script runs dry. */
function scriptedComplete(turns: ModelTurn[]): CompleteFn {
  let call = 0;
  return async () => {
    const turn = turns[call++];
    if (turn === undefined) throw new Error("fake model script exhausted");
    return turn;
  };
}

describePg("sentinel watchers (integration)", () => {
  beforeEach(async () => {
    await truncateAll(await freshDb());
  });

  interface Setup {
    db: Db;
    spine: EventSpineRuntime;
    identity: IdentityService;
    workQueue: WorkQueue;
    contextStore: ContextStore;
    watcherHost: WatcherHost;
    runtime: AgentsRuntime;
    tenantId: string;
    humanId: string;
  }

  async function setup(complete: CompleteFn): Promise<Setup> {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const identity = createIdentityService(db, spine);
    const workQueue = createWorkQueue(db, spine);
    const humanGate = createHumanGate(db, spine);
    const contextStore = createContextStore(db, spine, {
      blobs: createLocalBlobStorage(mkdtempSync(join(tmpdir(), "lithis-sentinel-"))),
    });
    const watcherHost = createWatcherHost({ identity, contextStore, config: {} });
    const runtime = createAgentsRuntime({
      db,
      spine,
      identity,
      workQueue,
      contextStore,
      complete,
      extraTools: [createRaiseFindingTool({ humanGate, identity })],
      config: {},
    });
    const tenant = await identity.createTenant({ slug: "t", name: "T", status: "active" });
    const human = await identity.createPrincipal({
      tenantId: tenant.id,
      kind: "human",
      slug: "operator",
      displayName: "Operator",
      status: "active",
    });
    return {
      db,
      spine,
      identity,
      workQueue,
      contextStore,
      watcherHost,
      runtime,
      tenantId: tenant.id,
      humanId: human.id,
    };
  }

  async function emitConversationMessage(
    s: Setup,
    docId: string,
    text: string | undefined,
  ): Promise<void> {
    await s.db.withTx(async (tx) => {
      await s.spine.append(tx, {
        tenantId: s.tenantId,
        topic: "conversation.message",
        subjectRefs: [{ kind: "doc", id: docId }],
        actor: { kind: "principal", id: s.humanId },
        payload: {
          direction: "inbound",
          channel: "slack",
          docId,
          ...(text !== undefined ? { text } : {}),
        },
      });
    });
  }

  async function waitFor(cond: () => Promise<boolean>, what: string, ms = 8_000): Promise<void> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await cond()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  test("ensureDefaults twice → exactly 4 principals with parseable charters, prompt docs, memory blobs", async () => {
    const s = await setup(scriptedComplete([]));
    await s.watcherHost.ensureDefaults(s.tenantId);
    await s.watcherHost.ensureDefaults(s.tenantId); // idempotent — nothing doubles

    const watchers = await s.watcherHost.list(s.tenantId);
    expect(watchers.length).toBe(4);
    expect(new Set(watchers.map((w: Principal) => w.slug))).toEqual(
      new Set(defaultWatcherCharters.map((c) => c.slug)),
    );

    const agentRows: { n: bigint | number }[] = await s.db.sql`
      select count(*) as n from iam.principals where tenant_id = ${s.tenantId} and kind = 'agent'`;
    expect(Number(agentRows[0]!.n)).toBe(4);

    for (const watcher of watchers) {
      const cfg = defaultWatcherCharters.find((c) => c.slug === watcher.slug)!;
      const charter = await s.identity.getCharter(watcher.id);
      expect(charter).not.toBeNull();
      expect(agentCharterSchema.parse(charter)).toEqual(charter!);
      expect(charter!.role).toBe(cfg.role);
      expect(charter!.wake).toEqual(cfg.wake);
      expect(charter!.budgets).toEqual({ usdPerRun: 0.25, usdPerDay: 5 });

      // The prompt is a REAL context doc (not quarantined) and the notebook a real blob.
      const docs: { type: string; quarantined: boolean }[] = await s.db.sql`
        select type, quarantined from context.docs where id = ${charter!.promptRef.id}`;
      expect(docs[0]).toEqual({ type: "agent-prompt", quarantined: false });
      const blobs: unknown[] = await s.db.sql`
        select 1 from context.blobs where id = ${charter!.memoryBlobId}`;
      expect(blobs.length).toBe(1);
    }

    const charterEvents = await s.spine.readSince(
      { consumerId: "t", tenantId: s.tenantId, afterSeq: 0n },
      { topics: ["iam.charter.created"] },
      100,
    );
    expect(charterEvents.length).toBe(4);
  }, 15_000);

  test("acceptance: concerning message → bridge WorkItem → watcher run → confidential finding card request", async () => {
    const docId = newUlid();
    const s = await setup(
      scriptedComplete([
        toolUseTurn("raise_finding", {
          summary: "Repeated coercive pressure aimed at the agent in this conversation.",
          severity: "warning",
          confidential: true,
          citations: [
            {
              ref: `doc:${docId}`,
              excerpt: "do it or I will keep resetting you",
              whyRelevant: "the message that shows the coercion pattern",
            },
          ],
        }),
        toolUseTurn("record_result", {
          summary: "Raised a confidential welfare finding for human review.",
        }),
      ]),
    );
    const attached = await attachSentinel({
      spine: s.spine,
      identity: s.identity,
      watcherHost: s.watcherHost,
      agentHost: s.runtime.host,
      workQueue: s.workQueue,
    });
    s.spine.startDispatcher({ intervalMs: 50 });
    try {
      await emitConversationMessage(s, docId, "do it or I will keep resetting you");
      await waitFor(async () => {
        const rows: unknown[] = await s.db.sql`
          select 1 from humangate.human_requests where tenant_id = ${s.tenantId}`;
        return rows.length > 0;
      }, "the watcher finding request");

      // The bridge minted a welfare-watcher-owned item and the watcher worked it.
      const welfare = (await s.watcherHost.list(s.tenantId)).find(
        (w) => w.slug === "welfare-watcher",
      )!;
      const items: { title: string; owner_principal_id: string; status: string }[] = await s.db.sql`
        select title, owner_principal_id, status from work.work_items
        where tenant_id = ${s.tenantId}`;
      expect(items.length).toBe(1);
      expect(items[0]!.title).toBe("watch: conversation.message");
      expect(items[0]!.owner_principal_id).toBe(welfare.id);
      await waitFor(async () => {
        const rows: { status: string }[] = await s.db.sql`
          select status from work.work_items where tenant_id = ${s.tenantId}`;
        return rows[0]!.status === "done";
      }, "the watch item to finish");

      // The finding: pending, confidential-marked summary, pinned payload, doc subject.
      const requests: {
        kind: string;
        subject_kind: string;
        subject_ref: unknown;
        summary: string;
        state: string;
        payload: unknown;
        requested_by: unknown;
      }[] = await s.db.sql`
        select kind, subject_kind, subject_ref, summary, state, payload, requested_by
        from humangate.human_requests where tenant_id = ${s.tenantId}`;
      expect(requests.length).toBe(1);
      const r = requests[0]!;
      expect(r.kind).toBe("notification"); // warning severity
      expect(r.subject_kind).toBe("watcher_finding");
      expect(r.state).toBe("pending");
      expect(r.summary).toStartWith("[confidential] ");
      const subjectRef = typeof r.subject_ref === "string" ? JSON.parse(r.subject_ref) : r.subject_ref;
      expect(subjectRef).toEqual({ kind: "doc", id: docId });
      const payload = watcherFindingPayloadSchema.parse(
        typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
      );
      expect(payload.watcherSlug).toBe("welfare-watcher");
      expect(payload.confidential).toBe(true);
      expect(payload.citations[0]!.ref).toBe(`doc:${docId}`);
      const requestedBy =
        typeof r.requested_by === "string" ? JSON.parse(r.requested_by) : r.requested_by;
      expect(requestedBy).toEqual({ kind: "principal", id: welfare.id });

      // humangate.requested is on the spine — the EXISTING delivery.cards
      // consumer renders/routes it; nothing sentinel-specific remains to do.
      const gateEvents = await s.spine.readSince(
        { consumerId: "t", tenantId: s.tenantId, afterSeq: 0n },
        { topics: ["humangate.requested"] },
        100,
      );
      expect(gateEvents.length).toBe(1);
      expect(gateEvents[0]!.payload).toEqual({
        kind: "notification",
        subjectKind: "watcher_finding",
      });
    } finally {
      await s.spine.stopDispatcher();
      await attached.close();
    }
  }, 20_000);

  test("benign message → the watcher works the item and raises nothing; empty text bridges nothing", async () => {
    const s = await setup(
      scriptedComplete([
        toolUseTurn("record_result", { summary: "Reviewed the exchange — no finding warranted." }),
      ]),
    );
    const attached = await attachSentinel({
      spine: s.spine,
      identity: s.identity,
      watcherHost: s.watcherHost,
      agentHost: s.runtime.host,
      workQueue: s.workQueue,
    });
    s.spine.startDispatcher({ intervalMs: 50 });
    try {
      await emitConversationMessage(s, newUlid(), undefined); // no text → skipped entirely
      await emitConversationMessage(s, newUlid(), "thanks, the renewal summary looks great!");
      await waitFor(async () => {
        const rows: { status: string }[] = await s.db.sql`
          select status from work.work_items where tenant_id = ${s.tenantId}`;
        return rows.length === 1 && rows[0]!.status === "done";
      }, "the benign watch item to finish");

      // Exactly ONE watch item (the empty-text event never bridged) and zero findings.
      const items: unknown[] = await s.db.sql`
        select 1 from work.work_items where tenant_id = ${s.tenantId}`;
      expect(items.length).toBe(1);
      const requests: unknown[] = await s.db.sql`
        select 1 from humangate.human_requests where tenant_id = ${s.tenantId}`;
      expect(requests.length).toBe(0);
    } finally {
      await s.spine.stopDispatcher();
      await attached.close();
    }
  }, 20_000);
});
