import { describe, expect, test } from "bun:test";
import {
  WORK_ITEM_STATUSES,
  WORK_ITEM_TRANSITIONS,
  assertTransition,
  canTransition,
  newUlid,
  nowIso,
  reachableStates,
  workEdgeSchema,
  workItemSchema,
  workNoteSchema,
  type WorkItemStatus,
} from "@lithis/core";
import { baseRecord, ids } from "./fixtures";

describe("WorkItem transition table", () => {
  const allowed: Array<[WorkItemStatus, WorkItemStatus]> = [
    ["pending", "ready"], // upstreams done / wakeAt reached
    ["ready", "claimed"],
    ["claimed", "running"],
    ["claimed", "ready"], // lease expired before start
    ["running", "done"],
    ["running", "awaiting_approval"],
    ["running", "blocked"],
    ["running", "failed"],
    ["running", "ready"], // lease expired mid-run
    ["awaiting_approval", "done"], // approved
    ["awaiting_approval", "ready"], // denied/modified → rework
    ["awaiting_approval", "stale"], // cascade superseded the result under review
    ["blocked", "ready"],
    ["failed", "ready"], // retry
    ["done", "stale"], // Invalidator cascade — the ONLY exit from done
    ["stale", "ready"],
    ["stale", "pending"],
    ["pending", "cancelled"],
    ["running", "cancelled"],
  ];

  const denied: Array<[WorkItemStatus, WorkItemStatus]> = [
    ["pending", "running"], // must be claimed first
    ["pending", "done"],
    ["ready", "done"],
    ["done", "ready"], // done never reopens except via stale
    ["done", "cancelled"], // completed work cannot be cancelled
    ["cancelled", "ready"], // cancelled is terminal
    ["stale", "done"], // stale must rerun, not skip to done
    ["awaiting_approval", "running"],
  ];

  test.each(allowed)("allows %s → %s", (from, to) => {
    expect(canTransition(WORK_ITEM_TRANSITIONS, from, to)).toBe(true);
  });

  test.each(denied)("denies %s → %s", (from, to) => {
    expect(canTransition(WORK_ITEM_TRANSITIONS, from, to)).toBe(false);
    expect(() => assertTransition(WORK_ITEM_TRANSITIONS, from, to, "work item")).toThrow(
      /illegal work item transition/,
    );
  });

  test("every status is reachable from pending", () => {
    const reachable = reachableStates(WORK_ITEM_TRANSITIONS, "pending");
    for (const status of WORK_ITEM_STATUSES) {
      expect(reachable.has(status)).toBe(true);
    }
  });

  test("cancelled is terminal", () => {
    expect(WORK_ITEM_TRANSITIONS.cancelled).toHaveLength(0);
  });
});

describe("WorkItem schema", () => {
  test("round-trips a continuous follow-up item (the regulator scenario)", () => {
    const item = workItemSchema.parse({
      ...baseRecord(ids.workItem),
      revision: 3,
      kind: "continuous",
      title: "Get brokerage licensed in NJ",
      body: "Work NJ-DOBI to approval; follow up on cadence; escalate wet-signature forms.",
      status: "pending",
      ownerPrincipalId: ids.agentPrincipal,
      wakeAt: nowIso(),
      followUp: {
        counterpartRef: { kind: "entity", id: ids.entityPerson },
        cadence: "0 9 * * 1",
        nextAt: nowIso(),
        escalateAfterDays: 21,
        escalateToPrincipalId: ids.humanPrincipal,
      },
      sourceRefs: [{ kind: "doc", id: ids.doc }],
    });
    expect(item.kind).toBe("continuous");
    expect(item.priority).toBe(0.5); // default
    expect(item.attempt).toBe(0); // default
  });

  test("round-trips a leased process node", () => {
    const item = workItemSchema.parse({
      ...baseRecord(newUlid()),
      revision: 0,
      kind: "process_node",
      title: "Loss-history analysis",
      status: "running",
      ownerPrincipalId: ids.agentPrincipal,
      processRunId: ids.processRun,
      nodeKey: "loss_history",
      attempt: 1,
      lease: {
        holderPrincipalId: ids.agentPrincipal,
        runId: ids.run,
        expiresAt: nowIso(),
        heartbeatAt: nowIso(),
      },
    });
    expect(item.nodeKey).toBe("loss_history");
  });

  test("followUp counterpart must be an entity, not a principal", () => {
    const result = workItemSchema.safeParse({
      ...baseRecord(newUlid()),
      revision: 0,
      kind: "continuous",
      title: "x",
      status: "pending",
      ownerPrincipalId: ids.agentPrincipal,
      followUp: {
        counterpartRef: { kind: "principal", id: ids.humanPrincipal },
        cadence: "0 9 * * 1",
        nextAt: nowIso(),
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("WorkEdge / WorkNote", () => {
  test("edges carry only the two enforced verbs", () => {
    const edge = workEdgeSchema.parse({
      ...baseRecord(newUlid()),
      fromId: newUlid(),
      toId: ids.workItem,
      verb: "depends_on",
    });
    expect(edge.verb).toBe("depends_on");
    expect(
      workEdgeSchema.safeParse({
        ...baseRecord(newUlid()),
        fromId: newUlid(),
        toId: ids.workItem,
        verb: "relates_to",
      }).success,
    ).toBe(false);
  });

  test("notes are journal entries with an author ref", () => {
    const note = workNoteSchema.parse({
      id: newUlid(),
      tenantId: ids.tenant,
      workItemId: ids.workItem,
      at: nowIso(),
      byRef: { kind: "principal", id: ids.agentPrincipal },
      kind: "status",
      text: "Regulator acknowledged receipt; next check-in Monday.",
    });
    expect(note.kind).toBe("status");
  });
});
