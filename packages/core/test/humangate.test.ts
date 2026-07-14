import { describe, expect, test } from "bun:test";
import {
  HUMAN_REQUEST_STATES,
  HUMAN_REQUEST_TRANSITIONS,
  canTransition,
  humanRequestSchema,
  newUlid,
  nowIso,
  reachableStates,
  type HumanRequestState,
} from "@lithis/core";
import { baseRecord, ids } from "./fixtures";

describe("HumanRequest transition table", () => {
  const allowed: Array<[HumanRequestState, HumanRequestState]> = [
    ["pending", "approved"],
    ["pending", "denied"],
    ["pending", "modified"],
    ["pending", "answered"],
    ["pending", "acknowledged"],
    ["pending", "expired"],
    ["pending", "superseded"],
    ["approved", "superseded"], // cascade repudiated an already-granted approval
    ["modified", "superseded"],
  ];

  const denied: Array<[HumanRequestState, HumanRequestState]> = [
    ["approved", "denied"], // resolutions don't flip
    ["denied", "approved"],
    ["superseded", "pending"], // superseded requests are re-minted, never revived
    ["expired", "approved"],
  ];

  test.each(allowed)("allows %s → %s", (from, to) => {
    expect(canTransition(HUMAN_REQUEST_TRANSITIONS, from, to)).toBe(true);
  });

  test.each(denied)("denies %s → %s", (from, to) => {
    expect(canTransition(HUMAN_REQUEST_TRANSITIONS, from, to)).toBe(false);
  });

  test("every state is reachable from pending", () => {
    const reachable = reachableStates(HUMAN_REQUEST_TRANSITIONS, "pending");
    for (const state of HUMAN_REQUEST_STATES) {
      expect(reachable.has(state)).toBe(true);
    }
  });
});

describe("HumanRequest schema", () => {
  test("round-trips a node-result approval with deny resolution and comment", () => {
    const request = humanRequestSchema.parse({
      ...baseRecord(ids.humanRequest),
      kind: "approval",
      subjectKind: "node_result",
      subjectRef: { kind: "run_result", id: ids.runResult },
      payload: { nodeKey: "loss_history" },
      evidenceIds: [ids.evidence],
      summary: "Loss-history analysis for Acme Logistics — 3 claims flagged",
      routing: {
        assignee: { kind: "principal", id: ids.humanPrincipal },
        channelPrefs: ["slack", "portal"],
        slaHours: 24,
        escalationPath: ["underwriting-lead"],
        followUpCount: 1,
        nextFollowUpAt: nowIso(),
      },
      state: "denied",
      resolution: {
        by: { kind: "principal", id: ids.humanPrincipal },
        at: nowIso(),
        verdict: "denied",
        comment: "2019 claim is attributed to the wrong entity — recheck the loss run.",
      },
      requestedBy: { kind: "principal", id: ids.agentPrincipal },
    });
    expect(request.resolution?.comment).toContain("wrong entity");
  });

  test("round-trips an action_batch with per-item verdicts", () => {
    const intentA = newUlid();
    const intentB = newUlid();
    const request = humanRequestSchema.parse({
      ...baseRecord(newUlid()),
      kind: "approval",
      subjectKind: "action_batch",
      subjectRef: { kind: "action_intent", id: intentA },
      payload: { batchSize: 2, capability: "browser.linkedin.connect" },
      summary: "LinkedIn outreach batch: 2 prospects",
      routing: { assignee: "bd-owner", channelPrefs: ["portal"], escalationPath: [], followUpCount: 0 },
      state: "modified",
      resolution: {
        by: { kind: "principal", id: ids.humanPrincipal },
        at: nowIso(),
        verdict: "modified",
        comment: "Approved 1, softened the message on the other.",
        perItem: [
          { intentId: intentA, verdict: "approved" },
          { intentId: intentB, verdict: "modified", modification: { message: "softer opener" } },
        ],
      },
      requestedBy: { kind: "principal", id: ids.agentPrincipal },
    });
    expect(request.resolution?.perItem).toHaveLength(2);
  });

  test("subjectKind is a CLOSED enum — 'flag' (pre-amendment) is rejected", () => {
    const result = humanRequestSchema.safeParse({
      ...baseRecord(newUlid()),
      kind: "notification",
      subjectKind: "flag",
      subjectRef: { kind: "event", id: newUlid() },
      payload: {},
      summary: "x",
      routing: { assignee: "ops", channelPrefs: ["portal"], escalationPath: [], followUpCount: 0 },
      state: "pending",
      requestedBy: { kind: "principal", id: ids.agentPrincipal },
    });
    expect(result.success).toBe(false);
  });

  test("watcher_finding is the sentinel surface", () => {
    const result = humanRequestSchema.safeParse({
      ...baseRecord(newUlid()),
      kind: "notification",
      subjectKind: "watcher_finding",
      subjectRef: { kind: "event", id: newUlid() },
      payload: { category: "welfare", confidential: true },
      summary: "Abusive language toward the BD agent in #sales",
      routing: { assignee: "responsible-party", channelPrefs: ["portal"], escalationPath: [], followUpCount: 0 },
      state: "pending",
      requestedBy: { kind: "principal", id: ids.agentPrincipal },
    });
    expect(result.success).toBe(true);
  });
});
