import { beforeEach, expect, test } from "bun:test";
import { IllegalTransitionError, newUlid } from "@lithis/core";
import type { PrincipalContext, RunOutcome, WorkItemLease } from "@lithis/core";
import type { Db } from "../../src/db";
import { createEventSpine } from "../../src/spine";
import type { EventSpine } from "../../src/spine";
import { LeaseLostError, createLeaseReclaimTickSource, createWorkQueue } from "../../src/work";
import type { NewWorkItem, WorkQueueOptions } from "../../src/work";
import { describePg, freshDb, truncateAll } from "../helpers/pg";

function principal(tenantId: string): PrincipalContext {
  return { tenantId, principalId: newUlid(), kind: "agent" };
}

function item(tenantId: string, overrides: Partial<NewWorkItem> = {}): NewWorkItem {
  return {
    tenantId,
    kind: "oneoff",
    title: "test item",
    body: "",
    ownerPrincipalId: newUlid(),
    priority: 0.5,
    sourceRefs: [],
    ...overrides,
  };
}

function outcome(status: RunOutcome["status"]): RunOutcome {
  return { status, evidenceDrafts: [], newTasks: [], cost: { tokensIn: 0, tokensOut: 0, usd: 0 } };
}

interface ItemRow {
  status: string;
  attempt: number;
  lease: unknown;
}

async function getItem(db: Db, id: string): Promise<ItemRow & { parsedLease: WorkItemLease | null }> {
  const rows: ItemRow[] = await db.sql`
    select status, attempt, lease from work.work_items where id = ${id}`;
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: work item ${id} not found`);
  const raw = typeof row.lease === "string" ? (JSON.parse(row.lease) as unknown) : row.lease;
  return { ...row, parsedLease: raw === null || raw === undefined ? null : (raw as WorkItemLease) };
}

async function workEvents(
  spine: EventSpine,
  tenantId: string,
): Promise<{ topic: string; payload: unknown }[]> {
  const events = await spine.readSince(
    { consumerId: "t", tenantId, afterSeq: 0n },
    { topics: ["work.*"] },
    1_000,
  );
  return events.map((e) => ({ topic: e.topic, payload: e.payload }));
}

describePg("WorkQueue (integration)", () => {
  beforeEach(async () => {
    await truncateAll(await freshDb());
  });

  async function setup(opts?: WorkQueueOptions) {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const queue = createWorkQueue(db, spine, opts);
    const tenantId = newUlid();
    return { db, spine, queue, tenantId };
  }

  test("open: no wakeAt → ready, persisted per schema, emits work.item.opened", async () => {
    const { db, spine, queue, tenantId } = await setup();
    const id = await queue.open(item(tenantId, { title: "quote the account", priority: 0.9 }));

    const row = await getItem(db, id);
    expect(row.status).toBe("ready");
    expect(row.attempt).toBe(0);
    expect(row.parsedLease).toBeNull();

    const events = await workEvents(spine, tenantId);
    expect(events).toEqual([{ topic: "work.item.opened", payload: { kind: "oneoff" } }]);
  });

  test("open: process_node carries processRunId in the opened payload", async () => {
    const { spine, queue, tenantId } = await setup();
    const processRunId = newUlid();
    await queue.open(item(tenantId, { kind: "process_node", processRunId, nodeKey: "quote" }));
    const events = await workEvents(spine, tenantId);
    expect(events[0]!.payload).toEqual({ kind: "process_node", processRunId });
  });

  test("acceptance: open → claim → heartbeat → lapse → reclaim tick → second worker re-claims (attempt preserved)", async () => {
    const { db, spine, queue, tenantId } = await setup({ leaseTtlMs: 200 });
    const reclaim = createLeaseReclaimTickSource(db, spine);
    const workerA = principal(tenantId);
    const workerB = principal(tenantId);

    const id = await queue.open(item(tenantId));

    // A claims: lease held, attempt 1.
    const leaseA = await queue.claim(workerA, {});
    expect(leaseA).not.toBeNull();
    expect(leaseA!.workItemId).toBe(id);
    expect(leaseA!.holderPrincipalId).toBe(workerA.principalId);
    let row = await getItem(db, id);
    expect(row.status).toBe("claimed");
    expect(row.attempt).toBe(1);
    expect(row.parsedLease?.runId).toBe(leaseA!.runId);

    // Heartbeat extends the lease.
    const expiryBefore = Date.parse(row.parsedLease!.expiresAt);
    await new Promise((r) => setTimeout(r, 10));
    await queue.heartbeat(leaseA!);
    row = await getItem(db, id);
    expect(Date.parse(row.parsedLease!.expiresAt)).toBeGreaterThan(expiryBefore);

    // While the lease is live the reclaimer leaves it alone and B gets nothing.
    await reclaim.tick(new Date());
    expect((await getItem(db, id)).status).toBe("claimed");
    expect(await queue.claim(workerB, {})).toBeNull();

    // Lapse: the lease expires; A's lease is dead even before the reclaim tick.
    await new Promise((r) => setTimeout(r, 300));
    await expect(queue.heartbeat(leaseA!)).rejects.toThrow(LeaseLostError);

    // Reclaim tick: back to ready, attempt preserved, lease cleared.
    await reclaim.tick(new Date());
    row = await getItem(db, id);
    expect(row.status).toBe("ready");
    expect(row.attempt).toBe(1);
    expect(row.parsedLease).toBeNull();

    // B re-claims: attempt increments, fresh runId; A's stale lease stays dead.
    const leaseB = await queue.claim(workerB, {});
    expect(leaseB!.workItemId).toBe(id);
    expect(leaseB!.runId).not.toBe(leaseA!.runId);
    row = await getItem(db, id);
    expect(row.attempt).toBe(2);
    await expect(queue.release(leaseA!)).rejects.toThrow(LeaseLostError);
    await expect(queue.complete(leaseA!, outcome("done"))).rejects.toThrow(/held by run/);

    // B completes; the spine holds the full transition history.
    await queue.complete(leaseB!, outcome("done"));
    row = await getItem(db, id);
    expect(row.status).toBe("done");
    expect(row.parsedLease).toBeNull();

    const events = await workEvents(spine, tenantId);
    expect(events.map((e) => e.topic)).toEqual([
      "work.item.opened",
      "work.item.status_changed", // ready → claimed (A)
      "work.item.status_changed", // claimed → ready (reclaim)
      "work.item.status_changed", // ready → claimed (B)
      "work.item.status_changed", // claimed → running (complete's implicit hop)
      "work.item.status_changed", // running → done
    ]);
    expect(events.slice(1).map((e) => e.payload)).toEqual([
      { from: "ready", to: "claimed", attempt: 1 },
      { from: "claimed", to: "ready", attempt: 1 },
      { from: "ready", to: "claimed", attempt: 2 },
      { from: "claimed", to: "running", attempt: 2 },
      { from: "running", to: "done", attempt: 2 },
    ]);
  }, 10_000);

  test("claim: null when nothing is ready; claimed items are not claimable again", async () => {
    const { queue, tenantId } = await setup();
    const worker = principal(tenantId);
    expect(await queue.claim(worker, {})).toBeNull();

    await queue.open(item(tenantId));
    expect(await queue.claim(worker, {})).not.toBeNull();
    expect(await queue.claim(principal(tenantId), {})).toBeNull();
  });

  test("claim: highest-priority ready item wins; other tenants never leak", async () => {
    const { queue, tenantId } = await setup();
    await queue.open(item(tenantId, { title: "low", priority: 0.1 }));
    const highId = await queue.open(item(tenantId, { title: "high", priority: 0.9 }));
    await queue.open(item(newUlid(), { title: "other tenant", priority: 1 }));

    const lease = await queue.claim(principal(tenantId), {});
    expect(lease!.workItemId).toBe(highId);
  });

  test("ClaimFilter: kinds", async () => {
    const { queue, tenantId } = await setup();
    await queue.open(item(tenantId, { kind: "oneoff", priority: 1 }));
    const nodeId = await queue.open(
      item(tenantId, { kind: "process_node", processRunId: newUlid(), nodeKey: "n", priority: 0 }),
    );
    const lease = await queue.claim(principal(tenantId), { kinds: ["process_node"] });
    expect(lease!.workItemId).toBe(nodeId);
  });

  test("ClaimFilter: processRunId", async () => {
    const { queue, tenantId } = await setup();
    const runX = newUlid();
    const runY = newUlid();
    await queue.open(
      item(tenantId, { kind: "process_node", processRunId: runY, nodeKey: "n", priority: 1 }),
    );
    const xId = await queue.open(
      item(tenantId, { kind: "process_node", processRunId: runX, nodeKey: "n", priority: 0 }),
    );
    const lease = await queue.claim(principal(tenantId), { processRunId: runX });
    expect(lease!.workItemId).toBe(xId);
  });

  test("ClaimFilter: ownedOnly claims only the caller's items", async () => {
    const { queue, tenantId } = await setup();
    const owner = principal(tenantId);
    const stranger = principal(tenantId);
    const ownedId = await queue.open(item(tenantId, { ownerPrincipalId: owner.principalId }));

    expect(await queue.claim(stranger, { ownedOnly: true })).toBeNull();
    const lease = await queue.claim(owner, { ownedOnly: true });
    expect(lease!.workItemId).toBe(ownedId);
  });

  test("SKIP LOCKED: two concurrent claims never get the same item", async () => {
    const { queue, tenantId } = await setup();
    await queue.open(item(tenantId, { title: "one" }));
    await queue.open(item(tenantId, { title: "two" }));

    const [a, b] = await Promise.all([
      queue.claim(principal(tenantId), {}),
      queue.claim(principal(tenantId), {}),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.workItemId).not.toBe(b!.workItemId);
  });

  test("SKIP LOCKED: one ready item + two concurrent claims → exactly one lease", async () => {
    const { queue, tenantId } = await setup();
    await queue.open(item(tenantId));
    const results = await Promise.all([
      queue.claim(principal(tenantId), {}),
      queue.claim(principal(tenantId), {}),
    ]);
    expect(results.filter((r) => r !== null).length).toBe(1);
  });

  test("complete: RunOutcome statuses drive the state machine", async () => {
    const cases = [
      ["human_blocked", "awaiting_approval"],
      ["blocked", "blocked"],
      ["needs_decomposition", "blocked"],
      ["failed", "failed"],
      ["cancelled", "cancelled"],
    ] as const;
    const { db, queue, tenantId } = await setup();
    for (const [runStatus, itemStatus] of cases) {
      const id = await queue.open(item(tenantId));
      const lease = await queue.claim(principal(tenantId), {});
      expect(lease!.workItemId).toBe(id);
      await queue.complete(lease!, outcome(runStatus));
      const row = await getItem(db, id);
      expect(row.status).toBe(itemStatus);
      expect(row.parsedLease).toBeNull();
    }
  });

  test("complete: illegal transition is rejected by the core table", async () => {
    const { db, queue, tenantId } = await setup();
    await queue.open(item(tenantId));
    const lease = await queue.claim(principal(tenantId), {});
    // Fixture corruption: force a state complete() may not leave (done is
    // terminal except for the Invalidator) while keeping the lease live.
    await db.sql`update work.work_items set status = 'done' where id = ${lease!.workItemId}`;
    await expect(queue.complete(lease!, outcome("done"))).rejects.toThrow(IllegalTransitionError);
  });

  test("release: back to ready with attempt preserved; the released lease is dead", async () => {
    const { db, spine, queue, tenantId } = await setup();
    const id = await queue.open(item(tenantId));
    const lease = await queue.claim(principal(tenantId), {});
    await queue.release(lease!);

    const row = await getItem(db, id);
    expect(row.status).toBe("ready");
    expect(row.attempt).toBe(1);
    expect(row.parsedLease).toBeNull();
    await expect(queue.heartbeat(lease!)).rejects.toThrow(LeaseLostError);

    const events = await workEvents(spine, tenantId);
    expect(events.at(-1)!.payload).toEqual({ from: "claimed", to: "ready", attempt: 1 });

    // Re-claim after release increments attempt again.
    const again = await queue.claim(principal(tenantId), {});
    expect((await getItem(db, again!.workItemId)).attempt).toBe(2);
  });

  test("wakeAt: future wake opens pending; the tick flips it once due", async () => {
    const { db, spine, queue, tenantId } = await setup();
    const reclaim = createLeaseReclaimTickSource(db, spine);
    const wakeAt = new Date(Date.now() + 60_000).toISOString();
    const id = await queue.open(item(tenantId, { kind: "continuous", wakeAt }));

    expect((await getItem(db, id)).status).toBe("pending");
    expect(await queue.claim(principal(tenantId), {})).toBeNull();

    await reclaim.tick(new Date()); // not due yet
    expect((await getItem(db, id)).status).toBe("pending");

    await reclaim.tick(new Date(Date.now() + 61_000)); // clock reaches wakeAt
    expect((await getItem(db, id)).status).toBe("ready");
    const events = await workEvents(spine, tenantId);
    expect(events.at(-1)!.payload).toEqual({ from: "pending", to: "ready", attempt: 0 });

    expect(await queue.claim(principal(tenantId), {})).not.toBeNull();
  });

  test("notes: append-only journal emits work.note.added; unknown item throws", async () => {
    const { db, spine, queue, tenantId } = await setup();
    const id = await queue.open(item(tenantId));
    const byRef = { kind: "principal", id: newUlid() } as const;
    await queue.addNote(id, { byRef, kind: "human", text: "carrier called back" });
    await queue.addNote(id, { byRef, kind: "system", text: "lease reclaimed once" });

    const rows: { kind: string; text: string; by_ref: unknown }[] = await db.sql`
      select kind, text, by_ref from work.work_notes where work_item_id = ${id} order by at, id`;
    expect(rows.map((r) => [r.kind, r.text])).toEqual([
      ["human", "carrier called back"],
      ["system", "lease reclaimed once"],
    ]);

    const events = await workEvents(spine, tenantId);
    expect(events.filter((e) => e.topic === "work.note.added").map((e) => e.payload)).toEqual([
      { noteKind: "human" },
      { noteKind: "system" },
    ]);

    expect(
      queue.addNote(newUlid(), { byRef, kind: "human", text: "nope" }),
    ).rejects.toThrow(/does not exist/);
  });

  test("claim prefers owner-matched items over higher priority, without excluding cross-claims", async () => {
    const { queue, tenantId } = await setup();
    const worker = principal(tenantId);
    const otherOwner = newUlid();
    const hot = await queue.open(item(tenantId, { title: "hot", priority: 0.9, ownerPrincipalId: otherOwner }));
    const mine = await queue.open(
      item(tenantId, { title: "mine", priority: 0.1, ownerPrincipalId: worker.principalId }),
    );

    // Soft preference: the low-priority OWNED item wins the first claim…
    const first = await queue.claim(worker, {});
    expect(first?.workItemId).toBe(mine);
    // …but ownership never excludes: the same worker still claims the other item.
    const second = await queue.claim(worker, {});
    expect(second?.workItemId).toBe(hot);
  });

  test("reassign changes the owner, journals a system note, and no-ops on the same owner", async () => {
    const { db, spine, queue, tenantId } = await setup();
    const from = newUlid();
    const to = newUlid();
    const actor = { kind: "principal", id: newUlid() } as const;
    const id = await queue.open(item(tenantId, { ownerPrincipalId: from }));

    await queue.reassign(id, to, actor);
    await queue.reassign(id, to, actor); // same owner → no second note

    const rows: { owner_principal_id: string; revision: number }[] = await db.sql`
      select owner_principal_id, revision from work.work_items where id = ${id}`;
    expect(rows[0]!.owner_principal_id).toBe(to);
    expect(rows[0]!.revision).toBe(1);

    const notes: { kind: string; text: string; by_ref: unknown }[] = await db.sql`
      select kind, text, by_ref from work.work_notes where work_item_id = ${id}`;
    expect(notes.length).toBe(1);
    expect(notes[0]!.kind).toBe("system");
    expect(notes[0]!.text).toBe(`owner reassigned: ${from} → ${to}`);
    const byRef =
      typeof notes[0]!.by_ref === "string" ? JSON.parse(notes[0]!.by_ref) : notes[0]!.by_ref;
    expect(byRef).toEqual(actor);

    const events = await workEvents(spine, tenantId);
    expect(events.map((e) => e.topic)).toEqual(["work.item.opened", "work.note.added"]);

    await expect(queue.reassign(newUlid(), to, actor)).rejects.toThrow(/does not exist/);
  });

  test("outbox: open commits the row and its event atomically (rollback proof)", async () => {
    const { db, spine, tenantId } = await setup();
    const failingSpine: EventSpine = {
      append: () => Promise.reject(new Error("append rejected (outbox proof)")),
      subscribe: spine.subscribe,
      readSince: spine.readSince,
    };
    const queue = createWorkQueue(db, failingSpine);

    await expect(queue.open(item(tenantId))).rejects.toThrow(/outbox proof/);
    const rows: unknown[] = await db.sql`
      select 1 from work.work_items where tenant_id = ${tenantId}`;
    expect(rows).toEqual([]);
  });
});
