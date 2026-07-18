import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { newUlid } from "@lithis/core";
import type { AgentCharter } from "@lithis/core";
import { createAgentsRuntime } from "../../src/agents";
import type { AgentsRuntime } from "../../src/agents";
import type { CompleteFn, ModelTurn } from "../../src/agents/executor";
import { createContextStore, createLocalBlobStorage } from "../../src/context";
import type { Db } from "../../src/db";
import { createPgIdentityService } from "../../src/iam/service";
import { createEventSpine } from "../../src/spine";
import type { EventSpineRuntime } from "../../src/spine";
import { createWorkQueue } from "../../src/work";
import type { WorkQueue } from "../../src/work";
import { describePg, freshDb, truncateAll } from "../helpers/pg";

/**
 * P7 acceptance — the resident agent loop end-to-end over real Postgres:
 * a seeded charter agent autonomously claims and works 3 work items (fake
 * LLM, real everything else: sessions, runs, results, transcripts, spine
 * events, lease protocol), and a budget abort fires mid-run.
 */

function toolUseTurn(name: string, input: unknown, usage?: ModelTurn["usage"]): ModelTurn {
  return {
    content: [
      { type: "tool_use", id: `toolu_${newUlid()}`, name, input } as Anthropic.Messages.ToolUseBlock,
    ],
    stopReason: "tool_use",
    usage: usage ?? { inputTokens: 1_000, outputTokens: 500 },
  };
}

/** Fake model: finish every run in one call by recording a result. */
function alwaysRecordResult(usage?: ModelTurn["usage"]): CompleteFn {
  return async (req) => {
    const briefText = JSON.stringify(req.messages[0]?.content ?? "");
    const summary = `done: ${briefText.slice(0, 60)}`;
    return toolUseTurn("record_result", { summary, resultJson: { ok: true } }, usage);
  };
}

describePg("agents resident loop (integration)", () => {
  beforeEach(async () => {
    await truncateAll(await freshDb());
  });

  interface Setup {
    db: Db;
    spine: EventSpineRuntime;
    workQueue: WorkQueue;
    runtime: AgentsRuntime;
    tenantId: string;
    principalId: string;
  }

  async function setup(input: {
    complete: CompleteFn;
    budgets?: AgentCharter["budgets"];
    wake?: AgentCharter["wake"];
  }): Promise<Setup> {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const identity = createPgIdentityService(db, spine);
    const workQueue = createWorkQueue(db, spine);
    const contextStore = createContextStore(db, spine, {
      blobs: createLocalBlobStorage(mkdtempSync(join(tmpdir(), "lithis-agents-"))),
    });

    const tenant = await identity.createTenant({ slug: "t", name: "T", status: "active" });
    const principal = await identity.createPrincipal({
      tenantId: tenant.id,
      kind: "agent",
      slug: "resident",
      displayName: "Resident Agent",
      status: "active",
    });
    await identity.createCharter({
      principalId: principal.id,
      tenantId: tenant.id,
      role: "You work the tenant's queue and report honestly.",
      promptRef: { kind: "doc", id: newUlid() },
      memoryBlobId: newUlid(),
      modelPolicy: { plan: "claude-sonnet-5", execute: "claude-sonnet-5", index: "claude-haiku-4-5" },
      budgets: input.budgets ?? { usdPerRun: 1, usdPerDay: 10 },
      wake: input.wake ?? { onMessages: false },
    });

    const runtime = createAgentsRuntime({
      db,
      spine,
      identity,
      workQueue,
      contextStore,
      complete: input.complete,
      config: {},
    });
    return { db, spine, workQueue, runtime, tenantId: tenant.id, principalId: principal.id };
  }

  async function openItem(s: Setup, title: string, ownerPrincipalId?: string): Promise<string> {
    return s.workQueue.open({
      tenantId: s.tenantId,
      kind: "oneoff",
      title,
      body: `please ${title}`,
      ownerPrincipalId: ownerPrincipalId ?? s.principalId,
      priority: 0.5,
      sourceRefs: [],
    });
  }

  test("acceptance: a seeded resident agent autonomously claims and works 3 items end-to-end", async () => {
    const s = await setup({ complete: alwaysRecordResult() });
    const items = [
      await openItem(s, "reconcile ledger"),
      await openItem(s, "chase the carrier"),
      await openItem(s, "summarize renewals"),
    ];

    await s.runtime.host.ensure(s.principalId);
    await s.runtime.host.wake(s.principalId, "manual");

    // All three work items are done and unleased.
    for (const id of items) {
      const item = await s.workQueue.get(id);
      expect(item?.status).toBe("done");
      expect(item?.lease).toBeUndefined();
    }

    // Three terminal runs with metered cost and durable transcripts.
    const runs: { status: string; cost: unknown; transcript_blob_id: string | null; work_item_id: string }[] =
      await s.db.sql`
        select status, cost, transcript_blob_id, work_item_id
        from agents.runs where tenant_id = ${s.tenantId} order by id`;
    expect(runs.length).toBe(3);
    for (const run of runs) {
      expect(run.status).toBe("done");
      expect(run.transcript_blob_id).not.toBeNull();
      const cost = typeof run.cost === "string" ? JSON.parse(run.cost) : run.cost;
      expect(cost.usd).toBeCloseTo(0.0105, 6);
    }
    expect(new Set(runs.map((r) => r.work_item_id))).toEqual(new Set(items));

    // Each transcript blob is a real, distinct context blob.
    const blobs: { n: bigint | number }[] = await s.db.sql`
      select count(distinct id) as n from context.blobs where tenant_id = ${s.tenantId}`;
    expect(Number(blobs[0]!.n)).toBe(3);

    // Per-attempt results (attempt 0 for the first attempt on each item).
    const results: { attempt: number; summary: string; inputs_hash: string }[] = await s.db.sql`
      select attempt, summary, inputs_hash from agents.run_results where tenant_id = ${s.tenantId}`;
    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r.attempt).toBe(0);
      expect(r.summary).toStartWith("done:");
      expect(r.inputs_hash.length).toBe(64);
    }

    // The session closed with the aggregate cost, and the spine tells the story.
    const sessions: { ended_at: unknown; cost: unknown; summary: string }[] = await s.db.sql`
      select ended_at, cost, summary from agents.sessions where tenant_id = ${s.tenantId}`;
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.ended_at).not.toBeNull();
    const sessionCost =
      typeof sessions[0]!.cost === "string" ? JSON.parse(sessions[0]!.cost as string) : sessions[0]!.cost;
    expect(sessionCost.usd).toBeCloseTo(3 * 0.0105, 6);
    expect(sessions[0]!.summary).toContain("worked 3 item(s)");

    const events = await s.spine.readSince(
      { consumerId: "t", tenantId: s.tenantId, afterSeq: 0n },
      { topics: ["agent.*", "run.*", "session.*"] },
      1_000,
    );
    const topics = events.map((e) => e.topic);
    expect(topics[0]).toBe("session.started");
    expect(topics[1]).toBe("agent.woke");
    expect(topics.filter((t) => t === "run.started").length).toBe(3);
    expect(topics.filter((t) => t === "run.finished").length).toBe(3);
    expect(topics.filter((t) => t === "agent.tool_called").length).toBe(3);
    expect(topics.at(-2)).toBe("session.ended");
    expect(topics.at(-1)).toBe("agent.slept");
    const woke = events.find((e) => e.topic === "agent.woke");
    expect(woke!.payload).toEqual({ reason: "manual" });
  });

  test("acceptance: budget abort fires mid-run and the item lands cancelled", async () => {
    // One model call costs ~$150 against a $0.05 per-run budget.
    const s = await setup({
      complete: alwaysRecordResult({ inputTokens: 1_000, outputTokens: 10_000_000 }),
      budgets: { usdPerRun: 0.05, usdPerDay: 10 },
    });
    const itemId = await openItem(s, "expensive research");

    await s.runtime.host.ensure(s.principalId);
    await s.runtime.host.wake(s.principalId, "manual");

    const item = await s.workQueue.get(itemId);
    expect(item?.status).toBe("cancelled");

    const runs: { status: string; cost: unknown }[] = await s.db.sql`
      select status, cost from agents.runs where tenant_id = ${s.tenantId}`;
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("cancelled");
    const cost = typeof runs[0]!.cost === "string" ? JSON.parse(runs[0]!.cost as string) : runs[0]!.cost;
    expect(cost.usd).toBeGreaterThan(0.05); // the overrunning call was metered

    // Mid-run proof: the model WAS called, but its terminal tool never executed.
    const results: unknown[] = await s.db.sql`
      select 1 from agents.run_results where tenant_id = ${s.tenantId}`;
    expect(results.length).toBe(0);
    const toolEvents = await s.spine.readSince(
      { consumerId: "t2", tenantId: s.tenantId, afterSeq: 0n },
      { topics: ["agent.tool_called"] },
      100,
    );
    expect(toolEvents.length).toBe(0);
    const finished = await s.spine.readSince(
      { consumerId: "t3", tenantId: s.tenantId, afterSeq: 0n },
      { topics: ["run.finished"] },
      100,
    );
    expect(finished.length).toBe(1);
    expect((finished[0]!.payload as { status: string }).status).toBe("cancelled");
  });

  test("daily budget clamps the per-run budget and exhaustion stops the loop", async () => {
    // The remaining day budget ($0.005) clamps the first run's budget below
    // the model-call cost ($0.0105) → the run aborts; the spend then exhausts
    // the day, so the second item is never claimed.
    const s = await setup({
      complete: alwaysRecordResult(),
      budgets: { usdPerRun: 1, usdPerDay: 0.005 },
    });
    const first = await openItem(s, "first");
    const second = await openItem(s, "second");

    await s.runtime.host.ensure(s.principalId);
    await s.runtime.host.wake(s.principalId, "manual");

    const statuses = new Set([
      (await s.workQueue.get(first))?.status,
      (await s.workQueue.get(second))?.status,
    ]);
    expect(statuses).toEqual(new Set(["cancelled", "ready"]));

    const sessions: { summary: string }[] = await s.db.sql`
      select summary from agents.sessions where tenant_id = ${s.tenantId} order by id desc limit 1`;
    expect(sessions[0]!.summary).toContain("daily budget exhausted");

    // A second wake claims nothing more today.
    await s.runtime.host.wake(s.principalId, "manual");
    const runs: unknown[] = await s.db.sql`select 1 from agents.runs where tenant_id = ${s.tenantId}`;
    expect(runs.length).toBe(1);
  });

  test("event wake: work.item.opened via the dispatcher wakes the agent, which works the item", async () => {
    const s = await setup({
      complete: alwaysRecordResult(),
      wake: { onMessages: false, onEvents: ["work.item.opened"] },
    });
    await s.runtime.host.ensure(s.principalId);
    s.spine.startDispatcher({ intervalMs: 50 });
    try {
      // Owned by someone else: the opened-event actor is the owner, and the
      // host never wakes an agent on its own actions (livelock guard).
      const itemId = await openItem(s, "event driven", newUlid());
      const deadline = Date.now() + 5_000;
      for (;;) {
        const item = await s.workQueue.get(itemId);
        if (item?.status === "done") break;
        if (Date.now() > deadline) throw new Error(`item never worked (status ${item?.status})`);
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await s.spine.stopDispatcher();
    }
    const woke = await s.spine.readSince(
      { consumerId: "t4", tenantId: s.tenantId, afterSeq: 0n },
      { topics: ["agent.woke"] },
      100,
    );
    expect(woke.length).toBeGreaterThanOrEqual(1);
    expect((woke[0]!.payload as { reason: string }).reason).toBe("event");
  }, 10_000);

  test("heartbeat tick source: cron match wakes once per minute; sleep announces the next wake", async () => {
    const s = await setup({
      complete: alwaysRecordResult(),
      wake: { onMessages: false, heartbeat: "* * * * *" },
    });
    await s.runtime.host.ensure(s.principalId);
    const now = new Date();
    await s.runtime.heartbeatTickSource.tick(now);
    await s.runtime.heartbeatTickSource.tick(now); // same minute → coalesced, no second wake

    const woke = await s.spine.readSince(
      { consumerId: "t5", tenantId: s.tenantId, afterSeq: 0n },
      { topics: ["agent.woke"] },
      100,
    );
    expect(woke.length).toBe(1);
    expect((woke[0]!.payload as { reason: string }).reason).toBe("heartbeat");

    const slept = await s.spine.readSince(
      { consumerId: "t6", tenantId: s.tenantId, afterSeq: 0n },
      { topics: ["agent.slept"] },
      100,
    );
    const payload = slept[0]!.payload as { nextWakeAt?: string };
    expect(payload.nextWakeAt).toBeDefined();
    expect(new Date(payload.nextWakeAt!).getTime()).toBeGreaterThan(now.getTime());
    expect(await s.runtime.host.status(s.principalId)).toEqual({
      state: "sleeping",
      until: payload.nextWakeAt!,
    });
  });

  test("ensure without a charter refuses loudly", async () => {
    const s = await setup({ complete: alwaysRecordResult() });
    await expect(s.runtime.host.ensure(newUlid())).rejects.toThrow(/no agent charter/);
    expect(await s.runtime.host.status(newUlid())).toEqual({ state: "stopped" });
  });
});
