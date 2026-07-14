import { beforeEach, expect, test } from "bun:test";
import { newUlid } from "@lithis/core";
import type {
  Event,
  HumanResolution,
  PrincipalContext,
  Ref,
  RunOutcome,
  Ulid,
} from "@lithis/core";
import type { Db } from "../../src/db";
import { createHumanGate } from "../../src/humangate";
import type { HumanGate } from "../../src/humangate";
import { createProcessEngine, GraphChangeRejectedError, PROCESS_ENGINE_TOPICS } from "../../src/processes";
import type { NewProcessTemplate, ProcessEngine, RunResultPort } from "../../src/processes";
import { createEventSpine } from "../../src/spine";
import type { EventSpine } from "../../src/spine";
import { LeaseLostError, createWorkQueue } from "../../src/work";
import type { WorkQueue } from "../../src/work";
import { describePg, freshDb, truncateAll } from "../helpers/pg";

/**
 * P8 acceptance: the 3-node underwriting slice (intake → loss history →
 * carrier appetite, per docs/phases.md) instantiated through the real work
 * queue, then a live deny cascade and a live new-doc cascade — statuses,
 * gate supersession, lease revocation, and spine events all proven against
 * Postgres. The RunResultPort is a recording fixture (the real store is
 * P7-agents' agents.run_results).
 */

/** The 3-node underwriting template (trimmed from the insurance-brokerage pack). */
function underwriting3(tenantId: Ulid): NewProcessTemplate {
  return {
    tenantId,
    slug: "underwriting-smb-mini",
    version: "1.0.0",
    mode: "fixed",
    nodes: [
      {
        key: "intake",
        title: "Submission intake",
        instructions: "Normalize the inbound submission into the case record.",
        inputSelectors: [{ description: "ACORD forms", docTypes: ["acord_submission"] }],
        resultSchemaRef: "test/underwriting/intake@1",
        gate: "never",
      },
      {
        key: "loss_history_analysis",
        title: "Loss history analysis",
        instructions: "Analyze 3-5 years of carrier loss runs.",
        inputSelectors: [
          { description: "carrier loss runs", docTypes: ["loss_run"] },
          { description: "case facts", fromNodes: ["intake"] },
        ],
        resultSchemaRef: "test/underwriting/loss@1",
        gate: "always",
      },
      {
        key: "carrier_appetite_match",
        title: "Carrier appetite match",
        instructions: "Rank carriers against the risk profile.",
        inputSelectors: [
          { description: "loss picture", fromNodes: ["loss_history_analysis"] },
          { description: "appetite guides", query: "carrier appetite guide" },
        ],
        resultSchemaRef: "test/underwriting/appetite@1",
        gate: "auto_below_threshold",
      },
    ],
    edges: [
      { from: "loss_history_analysis", to: "intake", kind: "depends_on" },
      { from: "carrier_appetite_match", to: "loss_history_analysis", kind: "depends_on" },
    ],
    changePolicy: { allowAddNodes: false, allowSkip: false, protectedNodes: [] },
  };
}

function outcome(status: RunOutcome["status"]): RunOutcome {
  return { status, evidenceDrafts: [], newTasks: [], cost: { tokensIn: 0, tokensOut: 0, usd: 0 } };
}

function resolution(by: Ulid, verdict: HumanResolution["verdict"], comment = "reviewed"): HumanResolution {
  return { by: { kind: "principal", id: by }, at: new Date().toISOString(), verdict, comment };
}

/** Records supersessions instead of touching agents.run_results (P7's table). */
function recordingResultPort(): { port: RunResultPort; calls: { workItemId: Ulid; causeEventId?: Ulid }[] } {
  const calls: { workItemId: Ulid; causeEventId?: Ulid }[] = [];
  return {
    port: {
      supersede: (_tenantId, workItemId, causeEventId) => {
        calls.push({ workItemId, ...(causeEventId !== undefined ? { causeEventId } : {}) });
        return Promise.resolve(1);
      },
    },
    calls,
  };
}

describePg("ProcessEngine (integration)", () => {
  beforeEach(async () => {
    await truncateAll(await freshDb());
  });

  interface Harness {
    db: Db;
    spine: EventSpine;
    queue: WorkQueue;
    gate: HumanGate;
    engine: ProcessEngine;
    resultCalls: { workItemId: Ulid; causeEventId?: Ulid }[];
    tenantId: Ulid;
    owner: PrincipalContext;
    reviewer: PrincipalContext;
    /** Feed every not-yet-pumped spine event to engine.handleEvent (the durable consumer, minus the poll). */
    pump(): Promise<void>;
    topics(topicPrefix: string): Promise<{ topic: string; payload: unknown }[]>;
  }

  async function setup(opts?: { autoExecuteMaxWidth?: number }): Promise<Harness> {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const queue = createWorkQueue(db, spine);
    const gate = createHumanGate(db, spine);
    const { port, calls } = recordingResultPort();
    const engine = createProcessEngine({
      db,
      spine,
      work: queue,
      gate,
      results: port,
      ...(opts?.autoExecuteMaxWidth !== undefined
        ? { autoExecuteMaxWidth: opts.autoExecuteMaxWidth }
        : {}),
    });
    const tenantId = newUlid();
    const owner: PrincipalContext = { tenantId, principalId: newUlid(), kind: "agent" };
    const reviewer: PrincipalContext = { tenantId, principalId: newUlid(), kind: "human" };
    let afterSeq = 0n;
    const engineTopics: readonly string[] = PROCESS_ENGINE_TOPICS;
    return {
      db,
      spine,
      queue,
      gate,
      engine,
      resultCalls: calls,
      tenantId,
      owner,
      reviewer,
      async pump(): Promise<void> {
        // Loop until quiescent: handled events may emit new matching events.
        for (;;) {
          const events = await spine.readSince(
            { consumerId: "test", tenantId, afterSeq },
            undefined,
            1_000,
          );
          if (events.length === 0) return;
          for (const e of events) {
            afterSeq = e.seq;
            if (engineTopics.includes(e.topic)) await engine.handleEvent(e);
          }
        }
      },
      async topics(prefix: string): Promise<{ topic: string; payload: unknown }[]> {
        const events = await spine.readSince(
          { consumerId: "peek", tenantId, afterSeq: 0n },
          { topics: [prefix] },
          1_000,
        );
        return events.map((e) => ({ topic: e.topic, payload: e.payload }));
      },
    };
  }

  async function itemsByKey(h: Harness, runId: Ulid): Promise<Map<string, { id: Ulid; status: string; attempt: number }>> {
    const rows: { id: string; node_key: string; status: string; attempt: number }[] = await h.db.sql`
      select id, node_key, status, attempt from work.work_items
      where tenant_id = ${h.tenantId} and process_run_id = ${runId}`;
    return new Map(rows.map((r) => [r.node_key, { id: r.id, status: r.status, attempt: r.attempt }]));
  }

  /** Instantiate the 3-node underwriting template against a case entity. */
  async function instantiateUnderwriting(h: Harness): Promise<{ runId: Ulid; caseEntity: Ref; subject: Ref }> {
    const template = await h.engine.saveTemplate(underwriting3(h.tenantId));
    const caseEntity: Ref = { kind: "entity", id: newUlid() };
    const subject: Ref = { kind: "entity", id: caseEntity.id };
    const run = await h.engine.instantiate(
      { id: template.id, version: template.version },
      subject,
      { owner: h.owner, bindings: { case: caseEntity } },
    );
    return { runId: run.id, caseEntity, subject };
  }

  /** Claim + complete one node (the run's only ready item must be `key`). */
  async function runNode(
    h: Harness,
    runId: Ulid,
    key: string,
    status: RunOutcome["status"],
  ): Promise<Ulid> {
    const lease = await h.queue.claim(h.owner, { processRunId: runId });
    if (lease === null) throw new Error(`fixture: nothing claimable while expecting '${key}'`);
    const item = await h.queue.get(lease.workItemId);
    expect(item?.nodeKey).toBe(key);
    await h.queue.complete(lease, outcome(status));
    return lease.workItemId;
  }

  /** Simulate the P7 executor gating a node result behind a HumanRequest. */
  async function gateNodeResult(h: Harness, workItemId: Ulid): Promise<Ulid> {
    const req = await h.gate.request({
      tenantId: h.tenantId,
      kind: "approval",
      subjectKind: "node_result",
      subjectRef: { kind: "work_item", id: workItemId },
      payload: { attempt: 1 },
      evidenceIds: [],
      summary: "Review the node result",
      routing: {
        assignee: { kind: "principal", id: h.reviewer.principalId },
        channelPrefs: ["portal"],
        escalationPath: [],
        followUpCount: 0,
      },
      requestedBy: { kind: "principal", id: h.owner.principalId },
    });
    return req.id;
  }

  /** Run a node through claim → human_blocked → gate → approve (pumped). */
  async function runNodeApproved(h: Harness, runId: Ulid, key: string): Promise<{ itemId: Ulid; requestId: Ulid }> {
    const itemId = await runNode(h, runId, key, "human_blocked");
    const requestId = await gateNodeResult(h, itemId);
    await h.gate.resolve(requestId, resolution(h.reviewer.principalId, "approved"), h.reviewer);
    await h.pump();
    return { itemId, requestId };
  }

  /** A connector/context-shaped new-document event on the spine. */
  async function newDoc(h: Harness, docType: string): Promise<Event> {
    return await h.db.withTx((tx) =>
      h.spine.append(tx, {
        tenantId: h.tenantId,
        topic: "context.doc.created",
        subjectRefs: [{ kind: "doc", id: newUlid() }],
        actor: { kind: "tenant", id: h.tenantId },
        payload: { docType },
      }),
    );
  }

  test("instantiate: nodes as WorkItems via the queue, depends_on edges, WatchRules bound, events emitted", async () => {
    const h = await setup();
    const { runId, caseEntity } = await instantiateUnderwriting(h);

    const run = await h.engine.getRun(runId);
    expect(run?.status).toBe("active");
    expect(run?.graphRevision).toBe(0);

    const items = await itemsByKey(h, runId);
    expect(items.get("intake")?.status).toBe("ready");
    expect(items.get("loss_history_analysis")?.status).toBe("pending");
    expect(items.get("carrier_appetite_match")?.status).toBe("pending");
    const intake = await h.queue.get(items.get("intake")!.id);
    expect(intake?.kind).toBe("process_node");
    expect(intake?.body).toContain("Normalize");
    expect(intake?.sourceRefs).toContainEqual({ kind: "process_run", id: runId });

    const graph = await h.queue.graphForProcessRun(h.tenantId, runId);
    expect(graph.edges).toHaveLength(2);

    const rules: { node_key: string; match: unknown; mode: string }[] = await h.db.sql`
      select node_key, match, mode from processes.watch_rules
      where process_run_id = ${runId} order by node_key`;
    const parsed = rules.map((r) => ({
      nodeKey: r.node_key,
      mode: r.mode,
      match: typeof r.match === "string" ? JSON.parse(r.match) : r.match,
    }));
    expect(parsed).toEqual([
      {
        nodeKey: "carrier_appetite_match",
        mode: "deterministic",
        match: { topics: ["context.doc.distilled"], entityRefs: [caseEntity] },
      },
      {
        nodeKey: "intake",
        mode: "deterministic",
        match: { topics: ["context.doc.created"], docTypes: ["acord_submission"] },
      },
      {
        nodeKey: "loss_history_analysis",
        mode: "deterministic",
        match: { topics: ["context.doc.created"], docTypes: ["loss_run"] },
      },
    ]);

    expect((await h.topics("process.*")).map((e) => e.topic)).toEqual([
      "process.template.saved",
      "process.run.instantiated",
    ]);
    expect((await h.topics("process.run.instantiated"))[0]!.payload).toEqual({
      templateSlug: "underwriting-smb-mini",
      nodeCount: 3,
    });
  });

  test("chain readiness + approved gate: completing/approving a node unlocks its dependent", async () => {
    const h = await setup();
    const { runId } = await instantiateUnderwriting(h);

    await runNode(h, runId, "intake", "done");
    let items = await itemsByKey(h, runId);
    expect(items.get("loss_history_analysis")?.status).toBe("ready");
    expect(items.get("carrier_appetite_match")?.status).toBe("pending");

    // loss gates 'always': human_blocked → awaiting_approval; approval (via the
    // engine's event handling) completes it and unlocks the appetite node.
    const { itemId } = await runNodeApproved(h, runId, "loss_history_analysis");
    items = await itemsByKey(h, runId);
    expect(items.get("loss_history_analysis")?.status).toBe("done");
    expect(items.get("carrier_appetite_match")?.status).toBe("ready");
    expect(itemId).toBe(items.get("loss_history_analysis")!.id);
  });

  test("ACCEPTANCE deny cascade: a denied gate reruns the node (result superseded, rework claimable)", async () => {
    const h = await setup();
    const { runId } = await instantiateUnderwriting(h);
    await runNode(h, runId, "intake", "done");
    const lossId = await runNode(h, runId, "loss_history_analysis", "human_blocked");
    const requestId = await gateNodeResult(h, lossId);

    await h.gate.resolve(requestId, resolution(h.reviewer.principalId, "denied", "missing 2023 loss year"), h.reviewer);
    await h.pump();

    // The denial cascaded: loss went awaiting_approval → stale → ready for its
    // rerun; its (only) RunResult was superseded through the port; the
    // pending/granted-gate sweep had nothing else to flip (the denied request
    // is terminal 'denied', not superseded).
    const items = await itemsByKey(h, runId);
    expect(items.get("loss_history_analysis")?.status).toBe("ready");
    expect(items.get("carrier_appetite_match")?.status).toBe("pending");
    expect(h.resultCalls).toEqual([{ workItemId: lossId, causeEventId: expect.any(String) }]);
    const denied: { state: string }[] = await h.db.sql`
      select state from humangate.human_requests where id = ${requestId}`;
    expect(denied[0]!.state).toBe("denied");

    expect(await h.topics("process.cascade.*")).toEqual([
      {
        topic: "process.cascade.planned",
        payload: { dirtyNodeKey: "loss_history_analysis", width: 2, autoExecute: true },
      },
      {
        topic: "process.cascade.executed",
        payload: { dirtyNodeKey: "loss_history_analysis", staleCount: 1 },
      },
    ]);

    // The rerun is claimable NOW and carries the next attempt.
    const lease = await h.queue.claim(h.owner, { processRunId: runId });
    expect(lease?.workItemId).toBe(lossId);
    const row = await h.queue.get(lossId);
    expect(row?.attempt).toBe(2);
  });

  test("ACCEPTANCE new-doc cascade: a late loss run reruns loss history, stales downstream, supersedes granted gates", async () => {
    const h = await setup();
    const { runId } = await instantiateUnderwriting(h);
    await runNode(h, runId, "intake", "done");
    const loss = await runNodeApproved(h, runId, "loss_history_analysis");
    const appetite = await runNodeApproved(h, runId, "carrier_appetite_match");
    let items = await itemsByKey(h, runId);
    expect([...items.values()].every((i) => i.status === "done")).toBe(true);

    // A loss-run lands in the carrier portal mid-underwriting (step 1 of the
    // 7-step walkthrough) — the bound WatchRule matches THIS case's doc type.
    const docEvent = await newDoc(h, "loss_run");
    await h.pump();

    items = await itemsByKey(h, runId);
    expect(items.get("intake")?.status).toBe("done"); // upstream untouched
    expect(items.get("loss_history_analysis")?.status).toBe("ready"); // dirty → rerun
    expect(items.get("carrier_appetite_match")?.status).toBe("stale"); // parked on its upstream

    // Both granted node_result approvals flipped to superseded, carrying the cause event.
    const states: { id: string; state: string }[] = await h.db.sql`
      select id, state from humangate.human_requests where tenant_id = ${h.tenantId} order by id`;
    expect(states.find((s) => s.id === loss.requestId)?.state).toBe("superseded");
    expect(states.find((s) => s.id === appetite.requestId)?.state).toBe("superseded");
    const superseded = await h.topics("humangate.superseded");
    expect(superseded).toHaveLength(2);
    expect(superseded.map((e) => e.payload)).toEqual([
      { causeEventId: docEvent.id },
      { causeEventId: docEvent.id },
    ]);

    // RunResults superseded through the port for both invalidated nodes.
    expect(h.resultCalls.map((c) => c.workItemId).sort()).toEqual(
      [loss.itemId, appetite.itemId].sort(),
    );

    expect(await h.topics("process.cascade.*")).toEqual([
      {
        topic: "process.cascade.planned",
        payload: { dirtyNodeKey: "loss_history_analysis", width: 2, autoExecute: true },
      },
      {
        topic: "process.cascade.executed",
        payload: { dirtyNodeKey: "loss_history_analysis", staleCount: 2 },
      },
    ]);

    // The rerun (attempt 2) flows through its gate again; the stale dependent
    // wakes only when its upstream is done again.
    await runNodeApproved(h, runId, "loss_history_analysis");
    items = await itemsByKey(h, runId);
    expect(items.get("carrier_appetite_match")?.status).toBe("ready");
    expect(items.get("loss_history_analysis")?.attempt).toBe(2);
  });

  test("cascade revokes in-flight leases: the demoted dependent's worker loses its claim", async () => {
    const h = await setup();
    const { runId } = await instantiateUnderwriting(h);
    await runNode(h, runId, "intake", "done");
    await runNodeApproved(h, runId, "loss_history_analysis");
    const appetiteLease = await h.queue.claim(h.owner, { processRunId: runId });
    expect(appetiteLease).not.toBeNull();

    await newDoc(h, "loss_run");
    await h.pump();

    const items = await itemsByKey(h, runId);
    expect(items.get("loss_history_analysis")?.status).toBe("ready");
    expect(items.get("carrier_appetite_match")?.status).toBe("pending"); // revoked → demoted
    await expect(h.queue.heartbeat(appetiteLease!)).rejects.toThrow(LeaseLostError);
    await expect(h.queue.complete(appetiteLease!, outcome("done"))).rejects.toThrow(LeaseLostError);
  });

  test("over-width cascades park behind HumanRequest{cascade_plan}: approval executes, denial discards", async () => {
    const h = await setup({ autoExecuteMaxWidth: 1 });
    const { runId } = await instantiateUnderwriting(h);
    await runNode(h, runId, "intake", "done");
    await runNodeApproved(h, runId, "loss_history_analysis");
    await runNodeApproved(h, runId, "carrier_appetite_match");

    await newDoc(h, "loss_run");
    await h.pump();

    // Width 2 > 1: nothing moved; the plan is parked behind a cascade_plan gate.
    let items = await itemsByKey(h, runId);
    expect(items.get("loss_history_analysis")?.status).toBe("done");
    expect((await h.topics("process.cascade.planned")).at(-1)!.payload).toMatchObject({
      autoExecute: false,
      width: 2,
    });
    const holds: { human_request_id: string; kind: string }[] = await h.db.sql`
      select human_request_id, kind from processes.pending_actions where process_run_id = ${runId}`;
    expect(holds).toEqual([{ human_request_id: expect.any(String), kind: "cascade_plan" }]);

    // Approving the plan executes the cascade.
    await h.gate.resolve(
      holds[0]!.human_request_id,
      resolution(h.reviewer.principalId, "approved", "rerun it"),
      h.reviewer,
    );
    await h.pump();
    items = await itemsByKey(h, runId);
    expect(items.get("loss_history_analysis")?.status).toBe("ready");
    expect(items.get("carrier_appetite_match")?.status).toBe("stale");
    const cleared: unknown[] = await h.db.sql`select 1 from processes.pending_actions`;
    expect(cleared).toEqual([]);

    // Rebuild to done, park another plan, deny it → discarded, nothing moves.
    await runNodeApproved(h, runId, "loss_history_analysis");
    await h.db.sql`update work.work_items set status = 'done'
      where process_run_id = ${runId} and node_key = 'carrier_appetite_match'`; // fixture: fast-forward the stale→ready→…→done rerun
    await newDoc(h, "loss_run");
    await h.pump();
    const holds2: { human_request_id: string }[] = await h.db.sql`
      select human_request_id from processes.pending_actions where process_run_id = ${runId}`;
    expect(holds2).toHaveLength(1);
    await h.gate.resolve(
      holds2[0]!.human_request_id,
      resolution(h.reviewer.principalId, "denied", "not now"),
      h.reviewer,
    );
    await h.pump();
    items = await itemsByKey(h, runId);
    expect(items.get("loss_history_analysis")?.status).toBe("done");
    expect((await h.topics("process.cascade.discarded"))[0]!.payload).toMatchObject({
      dirtyNodeKey: "loss_history_analysis",
    });
    const cleared2: unknown[] = await h.db.sql`select 1 from processes.pending_actions`;
    expect(cleared2).toEqual([]);
  });

  test("entity-bound WatchRule: a distilled doc touching the case entity reruns the appetite node", async () => {
    const h = await setup();
    const { runId, caseEntity } = await instantiateUnderwriting(h);
    await runNode(h, runId, "intake", "done");
    await runNodeApproved(h, runId, "loss_history_analysis");
    await runNodeApproved(h, runId, "carrier_appetite_match");

    await h.db.withTx((tx) =>
      h.spine.append(tx, {
        tenantId: h.tenantId,
        topic: "context.doc.distilled",
        subjectRefs: [{ kind: "doc", id: newUlid() }, caseEntity],
        actor: { kind: "tenant", id: h.tenantId },
        payload: { entityIds: [caseEntity.id], linkIds: [] },
      }),
    );
    await h.pump();

    const items = await itemsByKey(h, runId);
    expect(items.get("carrier_appetite_match")?.status).toBe("ready"); // dirty leaf, revived
    expect(items.get("loss_history_analysis")?.status).toBe("done"); // upstream untouched
  });

  test("proposeGraphChange: fixed templates reject; dynamic runs gate, apply on approval", async () => {
    const h = await setup();
    const { runId } = await instantiateUnderwriting(h);
    await expect(
      h.engine.proposeGraphChange(runId, { addNodes: [], why: "nope" }, h.owner),
    ).rejects.toThrow(GraphChangeRejectedError);

    const dynamicRun = await h.engine.instantiate(
      {
        mode: "dynamic",
        goal: "research then draft",
        initialNodes: [
          {
            key: "research",
            title: "Research",
            instructions: "research the market",
            inputSelectors: [],
            resultSchemaRef: "test/dyn/research@1",
            gate: "never",
          },
        ],
      },
      { kind: "entity", id: newUlid() },
      { owner: h.owner },
    );

    const requestId = await h.engine.proposeGraphChange(
      dynamicRun.id,
      {
        addNodes: [
          {
            key: "draft",
            title: "Draft",
            instructions: "draft the memo",
            inputSelectors: [],
            resultSchemaRef: "test/dyn/draft@1",
            gate: "always",
          },
        ],
        addEdges: [{ from: "draft", to: "research" }],
        why: "the goal needs a deliverable",
      },
      h.owner,
    );
    expect((await h.topics("process.graph.change_proposed"))[0]!.payload).toMatchObject({
      humanRequestId: requestId,
      addNodeCount: 1,
    });

    await h.gate.resolve(requestId, resolution(h.reviewer.principalId, "approved"), h.reviewer);
    await h.pump();

    const items = await itemsByKey(h, dynamicRun.id);
    expect(items.get("draft")?.status).toBe("pending"); // parked behind research
    expect((await h.engine.getRun(dynamicRun.id))?.graphRevision).toBe(1);
    expect((await h.topics("process.graph.changed"))[0]!.payload).toEqual({
      graphRevision: 1,
      addedNodeKeys: ["draft"],
      cancelledNodeKeys: [],
    });

    // And the graph is live: completing research readies draft.
    await runNode(h, dynamicRun.id, "research", "done");
    expect((await itemsByKey(h, dynamicRun.id)).get("draft")?.status).toBe("ready");
  });

  test("outbox: instantiate commits run + rules + event atomically (rollback proof)", async () => {
    const h = await setup();
    const failingSpine: EventSpine = {
      append: () => Promise.reject(new Error("append rejected (outbox proof)")),
      subscribe: h.spine.subscribe,
      readSince: h.spine.readSince,
    };
    const engine = createProcessEngine({
      db: h.db,
      spine: failingSpine,
      work: h.queue,
      gate: h.gate,
    });
    const template = await h.engine.saveTemplate(underwriting3(h.tenantId));
    await expect(
      engine.instantiate({ id: template.id, version: template.version }, { kind: "entity", id: newUlid() }, { owner: h.owner }),
    ).rejects.toThrow(/outbox proof/);
    const runs: unknown[] = await h.db.sql`select 1 from processes.process_runs`;
    const rules: unknown[] = await h.db.sql`select 1 from processes.watch_rules`;
    const items: unknown[] = await h.db.sql`select 1 from work.work_items where tenant_id = ${h.tenantId}`;
    expect(runs).toEqual([]);
    expect(rules).toEqual([]);
    expect(items).toEqual([]);
  });
});
