import { describe, expect, test } from "bun:test";
import { NotImplementedError } from "@lithis/stubkit";
import { newUlid } from "@lithis/core";
import type { HumanRequest } from "@lithis/core";
import { createDelivery, createUnconfiguredDelivery } from "../../src/delivery";
import type { DeliveryDeps } from "../../src/delivery";

/**
 * P6-deliver went real: the old stubService cases are replaced by contract
 * tests for what REMAINS stubbed (non-slack rendering) and for the honest
 * DB-less config degrade. Behavior tests live in delivery.render.test.ts,
 * delivery.socketmode.test.ts, and integration/delivery.pg.test.ts.
 */

function fakeDeps(): DeliveryDeps {
  const nope = (): never => {
    throw new Error("not exercised in this test");
  };
  return {
    db: { sql: nope, withTx: nope, close: nope } as unknown as DeliveryDeps["db"],
    spine: { append: nope, subscribe: nope, readSince: nope } as unknown as DeliveryDeps["spine"],
    humanGate: { get: nope } as unknown as DeliveryDeps["humanGate"],
    runtime: { resolve: () => undefined, register: nope, slugs: () => [], probeFor: () => undefined },
    auth: { getAuth: nope, redeem: nope },
    connections: { findByConnector: async () => [] },
    contextStore: { putBlob: nope, ingestDoc: nope } as unknown as DeliveryDeps["contextStore"],
  };
}

function request(): HumanRequest {
  return {
    id: newUlid(),
    tenantId: newUlid(),
    kind: "approval",
    subjectKind: "action",
    subjectRef: { kind: "action_intent", id: newUlid() },
    payload: undefined,
    evidenceIds: [],
    summary: "Send it?",
    routing: { assignee: "underwriter", channelPrefs: ["slack"], escalationPath: [], followUpCount: 0 },
    state: "pending",
    requestedBy: { kind: "principal", id: newUlid() },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("delivery — remaining stubs and config degrade", () => {
  test("non-slack channels still throw the registered render stub", async () => {
    const delivery = createDelivery(fakeDeps());
    for (const channel of ["teams", "email", "portal"] as const) {
      const attempt = delivery.render({ kind: "human_request", request: request() }, channel);
      expect(attempt).rejects.toThrow(NotImplementedError);
      await attempt.catch((err: NotImplementedError) => {
        expect(err.stubId).toBe("server.delivery.render.non_slack");
        expect(err.reason).toStartWith("LITHIS-STUB:");
      });
    }
  });

  test("DB-less mode fails with a clear config error, not a stub", () => {
    const delivery = createUnconfiguredDelivery();
    expect(() => delivery.render({ kind: "human_request", request: request() }, "slack")).toThrow(
      /DATABASE_URL is not set/,
    );
    expect(() => delivery.findByAnchor(newUlid(), "C1:1.2")).toThrow(/DB-less skeleton mode/);
  });
});
