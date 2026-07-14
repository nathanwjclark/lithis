import type { HumanRequest } from "@lithis/core";

/**
 * The SLA follow-up/escalation policy — pure logic, exercised by the clock's
 * `humangate.sla` TickSource. INTERNAL responders only (external-party chasing
 * lives on WorkItem.followUp, a different machine on purpose).
 *
 * The ladder, driven entirely by fields the core routing schema already has:
 *
 *   1st due sweep  (followUpCount 0)      → follow_up: nudge the current
 *                                           assignee, reschedule one SLA out.
 *   nth due sweep  (followUpCount n ≥ 1)  → escalate: reassign to
 *                                           escalationPath[n-1], reschedule.
 *   path exhausted                        → expire (terminal; requester can
 *                                           re-request).
 *
 * A request with `nextFollowUpAt` but no `slaHours` gets exactly one
 * follow-up: with no interval to reschedule from, `nextFollowUpAt` is cleared
 * and the sweep never picks it up again.
 */

export type HumanRequestRouting = HumanRequest["routing"];

export interface SlaDecision {
  action: "follow_up" | "escalate" | "expire";
  /** The routing to persist alongside the action (expire keeps the count, clears the wake). */
  routing: HumanRequestRouting;
}

/** Whether the SLA sweep owes this routing an action at `now`. */
export function isDue(routing: HumanRequestRouting, now: Date): boolean {
  return (
    routing.nextFollowUpAt !== undefined && Date.parse(routing.nextFollowUpAt) <= now.getTime()
  );
}

/** The next wake `slaHours` from `now` — undefined when there is no interval to reschedule from. */
export function nextFollowUpAt(routing: HumanRequestRouting, now: Date): string | undefined {
  return routing.slaHours !== undefined
    ? new Date(now.getTime() + routing.slaHours * 3_600_000).toISOString()
    : undefined;
}

function reroute(
  routing: HumanRequestRouting,
  overrides: Partial<HumanRequestRouting>,
  wakeAt: string | undefined,
): HumanRequestRouting {
  // exactOptionalPropertyTypes: a cleared wake must be ABSENT, not undefined —
  // and a stale nextFollowUpAt would make the sweep fire forever.
  const { nextFollowUpAt: _cleared, ...rest } = routing;
  return { ...rest, ...overrides, ...(wakeAt !== undefined ? { nextFollowUpAt: wakeAt } : {}) };
}

/** Decide what a due sweep does. Callers must check `isDue` (and state === 'pending') first. */
export function decideSla(routing: HumanRequestRouting, now: Date): SlaDecision {
  const wakeAt = nextFollowUpAt(routing, now);
  if (routing.followUpCount === 0) {
    return { action: "follow_up", routing: reroute(routing, { followUpCount: 1 }, wakeAt) };
  }
  const target = routing.escalationPath[routing.followUpCount - 1];
  if (target !== undefined) {
    return {
      action: "escalate",
      routing: reroute(
        routing,
        { assignee: target, followUpCount: routing.followUpCount + 1 },
        wakeAt,
      ),
    };
  }
  return { action: "expire", routing: reroute(routing, {}, undefined) };
}
