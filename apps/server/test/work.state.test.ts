import { describe, expect, test } from "bun:test";
import { RUN_STATUSES, WORK_ITEM_TRANSITIONS, canTransition, newUlid } from "@lithis/core";
import type { WorkItemLease } from "@lithis/core";
import { LeaseLostError, OUTCOME_TO_STATUS, assertHeldLease, initialStatus } from "../src/work";
import type { Lease } from "../src/work";

const NOW = Date.parse("2026-07-14T12:00:00.000Z");

describe("initialStatus", () => {
  test("no wakeAt → ready (immediately claimable)", () => {
    expect(initialStatus(undefined, new Date(NOW))).toBe("ready");
  });

  test("past wakeAt → ready (the wake already fired)", () => {
    expect(initialStatus(new Date(NOW - 1_000).toISOString(), new Date(NOW))).toBe("ready");
  });

  test("future wakeAt → pending (sleeps until the clock flips it)", () => {
    expect(initialStatus(new Date(NOW + 1_000).toISOString(), new Date(NOW))).toBe("pending");
  });
});

describe("OUTCOME_TO_STATUS", () => {
  test("covers every non-running RunOutcome status", () => {
    const outcomeStatuses = RUN_STATUSES.filter((s) => s !== "running").sort();
    expect(Object.keys(OUTCOME_TO_STATUS).sort()).toEqual(outcomeStatuses);
  });

  test("every mapped target is a legal transition out of running", () => {
    for (const target of Object.values(OUTCOME_TO_STATUS)) {
      expect(canTransition(WORK_ITEM_TRANSITIONS, "running", target)).toBe(true);
    }
  });
});

describe("assertHeldLease", () => {
  function fixtureLease(): { stored: WorkItemLease; held: Lease } {
    const stored: WorkItemLease = {
      holderPrincipalId: newUlid(),
      runId: newUlid(),
      expiresAt: new Date(NOW + 60_000).toISOString(),
      heartbeatAt: new Date(NOW).toISOString(),
    };
    return { stored, held: { ...stored, workItemId: newUlid() } };
  }

  test("returns the lease when holder + runId match and it is live", () => {
    const { stored, held } = fixtureLease();
    expect(assertHeldLease(stored, held, NOW, "heartbeat")).toEqual(stored);
  });

  test("throws when the row holds no lease (null / malformed)", () => {
    const { held } = fixtureLease();
    expect(() => assertHeldLease(null, held, NOW, "heartbeat")).toThrow(LeaseLostError);
    expect(() => assertHeldLease({ nonsense: true }, held, NOW, "heartbeat")).toThrow(
      /holds no lease/,
    );
  });

  test("throws when another principal holds the lease", () => {
    const { stored, held } = fixtureLease();
    expect(() =>
      assertHeldLease({ ...stored, holderPrincipalId: newUlid() }, held, NOW, "release"),
    ).toThrow(LeaseLostError);
  });

  test("throws when the runId differs (re-claimed by a later run)", () => {
    const { stored, held } = fixtureLease();
    expect(() => assertHeldLease({ ...stored, runId: newUlid() }, held, NOW, "complete")).toThrow(
      /held by run/,
    );
  });

  test("throws when the lease has expired, even if unreclaimed", () => {
    const { stored, held } = fixtureLease();
    const expired = { ...stored, expiresAt: new Date(NOW - 1).toISOString() };
    expect(() => assertHeldLease(expired, held, NOW, "heartbeat")).toThrow(/expired at/);
  });
});
