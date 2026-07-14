import { workItemLeaseSchema } from "@lithis/core";
import type { RunOutcome, WorkItemLease, WorkItemStatus } from "@lithis/core";
import type { Lease } from "./index";

/**
 * Pure lease/state-machine logic for the work queue — no I/O, unit-tested in
 * apps/server/test/work.state.test.ts. WORK_ITEM_TRANSITIONS (in @lithis/core)
 * stays the single authority; these helpers only pick entry points and map
 * run outcomes onto it.
 */

/**
 * Initial status for a freshly opened item: a future wakeAt means the item
 * sleeps as `pending` until the clock's lease-reclaim tick flips it; anything
 * else is immediately claimable. (pending→ready via depends_on completion is
 * P8-process territory — edges ship in the schema but have no queue surface.)
 */
export function initialStatus(wakeAt: string | undefined, now: Date): WorkItemStatus {
  return wakeAt !== undefined && Date.parse(wakeAt) > now.getTime() ? "pending" : "ready";
}

/**
 * RunOutcome.status → WorkItem status, per WORK_ITEM_TRANSITIONS (all targets
 * are legal moves out of `running`). `needs_decomposition` lands on `blocked`:
 * the item cannot proceed as-is until P7-agents spawns subtasks for it.
 */
export const OUTCOME_TO_STATUS = {
  done: "done",
  human_blocked: "awaiting_approval",
  blocked: "blocked",
  needs_decomposition: "blocked",
  failed: "failed",
  cancelled: "cancelled",
} as const satisfies Record<RunOutcome["status"], WorkItemStatus>;

/** heartbeat/release/complete on a lease the caller no longer holds. */
export class LeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseLostError";
  }
}

/**
 * Validate that the caller still holds the item's lease: a lease exists, the
 * holder + runId match, and it has not expired. An expired lease is DEAD even
 * before the reclaim tick notices — otherwise a slow worker and the reclaimer
 * race for the item. Returns the held lease on success.
 */
export function assertHeldLease(storedLease: unknown, l: Lease, nowMs: number, op: string): WorkItemLease {
  const parsed = workItemLeaseSchema.safeParse(storedLease);
  if (!parsed.success) {
    throw new LeaseLostError(
      `${op}: work item ${l.workItemId} holds no lease (released, reclaimed, or completed)`,
    );
  }
  const held = parsed.data;
  if (held.holderPrincipalId !== l.holderPrincipalId || held.runId !== l.runId) {
    throw new LeaseLostError(
      `${op}: lease on work item ${l.workItemId} is held by run ${held.runId} ` +
        `(principal ${held.holderPrincipalId}), not run ${l.runId}`,
    );
  }
  if (Date.parse(held.expiresAt) <= nowMs) {
    throw new LeaseLostError(
      `${op}: lease on work item ${l.workItemId} expired at ${held.expiresAt}`,
    );
  }
  return held;
}
