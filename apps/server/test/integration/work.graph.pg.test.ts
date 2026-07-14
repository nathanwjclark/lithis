import { beforeEach, expect, test } from "bun:test";
import { IllegalTransitionError, newUlid } from "@lithis/core";
import type { PrincipalContext, Ref, RunOutcome } from "@lithis/core";
import type { Db } from "../../src/db";
import { createEventSpine } from "../../src/spine";
import { LeaseLostError, createWorkQueue } from "../../src/work";
import type { NewWorkItem, WorkQueue } from "../../src/work";
import { describePg, freshDb, truncateAll } from "../helpers/pg";

/**
 * P8 additions to the work queue: the WorkEdge surface (dependsOn opens,
 * done-promotion) and the Invalidator surface
 * (markStale/revive/demote/revokeLease/cancel/resolveApproval).
 */

function principal(tenantId: string): PrincipalContext {
  return { tenantId, principalId: newUlid(), kind: "agent" };
}

function item(tenantId: string, overrides: Partial<NewWorkItem> = {}): NewWorkItem {
  return {
    tenantId,
    kind: "oneoff",
    title: "graph item",
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

async function status(db: Db, id: string): Promise<string> {
  const rows: { status: string }[] = await db.sql`
    select status from work.work_items where id = ${id}`;
  return rows[0]!.status;
}

/** Claim the ready queue until a specific item comes up, then complete it. */
async function completeItem(
  queue: WorkQueue,
  p: PrincipalContext,
  id: string,
  status_: RunOutcome["status"] = "done",
): Promise<void> {
  const lease = await queue.claim(p, {});
  if (lease === null || lease.workItemId !== id) {
    throw new Error(`fixture: expected to claim ${id}, got ${lease?.workItemId ?? "nothing"}`);
  }
  await queue.complete(lease, outcome(status_));
}

describePg("WorkQueue graph + Invalidator surface (integration)", () => {
  beforeEach(async () => {
    await truncateAll(await freshDb());
  });

  async function setup() {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const queue = createWorkQueue(db, spine);
    const tenantId = newUlid();
    const actor: Ref = { kind: "tenant", id: tenantId };
    return { db, spine, queue, tenantId, actor };
  }

  test("open with dependsOn: parks pending behind unfinished upstreams; done upstreams keep it ready", async () => {
    const { db, queue, tenantId } = await setup();
    const worker = principal(tenantId);
    const upstream = await queue.open(item(tenantId, { title: "upstream", priority: 1 }));
    const dependent = await queue.open(item(tenantId, { title: "dependent" }), {
      dependsOn: [upstream],
    });
    expect(await status(db, dependent)).toBe("pending");

    await completeItem(queue, worker, upstream);
    expect(await status(db, dependent)).toBe("ready");

    // Depending only on an already-done upstream opens ready.
    const late = await queue.open(item(tenantId, { title: "late" }), { dependsOn: [upstream] });
    expect(await status(db, late)).toBe("ready");

    await expect(
      queue.open(item(tenantId), { dependsOn: [newUlid()] }),
    ).rejects.toThrow(/does not exist/);
  });

  test("diamond promotion: dependent flips ready only when ALL upstreams are done", async () => {
    const { db, queue, tenantId } = await setup();
    const worker = principal(tenantId);
    const a = await queue.open(item(tenantId, { title: "a", priority: 0.9 }));
    const b = await queue.open(item(tenantId, { title: "b", priority: 0.8 }));
    const join = await queue.open(item(tenantId, { title: "join" }), { dependsOn: [a, b] });

    await completeItem(queue, worker, a);
    expect(await status(db, join)).toBe("pending");
    await completeItem(queue, worker, b);
    expect(await status(db, join)).toBe("ready");
  });

  test("resolveApproval: awaiting_approval → done, promoting dependents", async () => {
    const { db, queue, tenantId, actor } = await setup();
    const worker = principal(tenantId);
    const gated = await queue.open(item(tenantId, { title: "gated" }));
    const dependent = await queue.open(item(tenantId), { dependsOn: [gated] });
    await completeItem(queue, worker, gated, "human_blocked");
    expect(await status(db, gated)).toBe("awaiting_approval");
    expect(await status(db, dependent)).toBe("pending");

    await queue.resolveApproval(gated, actor);
    expect(await status(db, gated)).toBe("done");
    expect(await status(db, dependent)).toBe("ready");

    // Redelivery / double-resolve is an illegal transition, not a silent no-op.
    await expect(queue.resolveApproval(gated, actor)).rejects.toThrow(IllegalTransitionError);
  });

  test("Invalidator surface: markStale → revive routes by upstream doneness; demote; cancel", async () => {
    const { db, queue, tenantId, actor } = await setup();
    const worker = principal(tenantId);
    const up = await queue.open(item(tenantId, { title: "up", priority: 1 }));
    const down = await queue.open(item(tenantId, { title: "down" }), { dependsOn: [up] });
    await completeItem(queue, worker, up);
    await completeItem(queue, worker, down);

    // Both done. Stale them; revive routes down to pending (its upstream is stale).
    await queue.markStale(down, actor);
    await queue.markStale(up, actor);
    expect(await queue.revive(down, actor)).toBe("pending");
    expect(await queue.revive(up, actor)).toBe("ready");

    // demote: ready → pending; markStale from ready is illegal.
    await queue.demote(up, actor);
    expect(await status(db, up)).toBe("pending");
    await expect(queue.markStale(up, actor)).rejects.toThrow(IllegalTransitionError);

    await queue.cancel(down, actor);
    expect(await status(db, down)).toBe("cancelled");
  });

  test("revokeLease: claimed → ready, attempt preserved, the old lease is dead", async () => {
    const { db, queue, tenantId, actor } = await setup();
    const id = await queue.open(item(tenantId));
    const lease = await queue.claim(principal(tenantId), {});
    expect(lease!.workItemId).toBe(id);

    await queue.revokeLease(id, actor);
    expect(await status(db, id)).toBe("ready");
    const rows: { attempt: number; lease: unknown }[] = await db.sql`
      select attempt, lease from work.work_items where id = ${id}`;
    expect(rows[0]!.attempt).toBe(1);
    expect(rows[0]!.lease).toBeNull();
    await expect(queue.heartbeat(lease!)).rejects.toThrow(LeaseLostError);
    await expect(queue.complete(lease!, outcome("done"))).rejects.toThrow(LeaseLostError);
  });

  test("get + graphForProcessRun: items round-trip the schema; edges scoped to the run", async () => {
    const { queue, tenantId } = await setup();
    const processRunId = newUlid();
    const node = (key: string): NewWorkItem =>
      item(tenantId, { kind: "process_node", processRunId, nodeKey: key, title: key });
    const a = await queue.open(node("a"));
    const b = await queue.open(node("b"), { dependsOn: [a] });
    const stray = await queue.open(item(tenantId, { title: "not in the run" }), { dependsOn: [a] });

    const got = await queue.get(b);
    expect(got?.nodeKey).toBe("b");
    expect(got?.processRunId).toBe(processRunId);
    expect(got?.status).toBe("pending");
    expect(await queue.get(newUlid())).toBeUndefined();

    const graph = await queue.graphForProcessRun(tenantId, processRunId);
    expect(graph.items.map((i) => i.nodeKey).sort()).toEqual(["a", "b"]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ fromId: b, toId: a, verb: "depends_on" });
    expect(graph.items.some((i) => i.id === stray)).toBe(false);
  });
});
