import { cronMatches } from "@lithis/core";
import type { Cron } from "@lithis/core";
import { txSql } from "../db";
import type { Db } from "../db";
import type { EventSpine, TickSource } from "../spine";
import { rowToFeedExpectation, toIso } from "./shared";
import type { FeedExpectationRow } from "./shared";

/**
 * FeedExpectation grace-window math + the clock TickSource that turns quiet
 * feeds into feed.expectation.missed events. Miss semantics: a cron fire is
 * "missed" once its grace window has fully elapsed with no arrival recorded
 * after it. The persisted missedCount doubles as the once-only guard — a tick
 * emits only when the number of due misses has GROWN past what was already
 * flagged, so a missed feed is announced once per missed occurrence, not once
 * per 30-second tick. recordFeedSeen resets lastSeenAt + missedCount, which
 * both recovers the feed and re-arms the watchdog.
 */

/** Don't scan cron fires further back than this (guards pathological gaps). */
export const MAX_SCAN_MINUTES = 60 * 24 * 60; // 60 days

const MINUTE_MS = 60_000;

/**
 * Count cron fires F with base < F and F + graceMinutes <= now — i.e. the
 * expected arrivals whose grace window has fully elapsed since the feed was
 * last seen (or since the expectation was created).
 */
export function countDueMisses(
  expr: Cron,
  base: Date,
  now: Date,
  graceMinutes: number,
): number {
  const deadlineCutoffMs = now.getTime() - graceMinutes * MINUTE_MS;
  const floorMs = Math.max(base.getTime(), now.getTime() - MAX_SCAN_MINUTES * MINUTE_MS);
  // First whole minute strictly after the base.
  let cursorMs = (Math.floor(floorMs / MINUTE_MS) + 1) * MINUTE_MS;
  let missed = 0;
  while (cursorMs <= deadlineCutoffMs) {
    if (cronMatches(expr, new Date(cursorMs))) missed += 1;
    cursorMs += MINUTE_MS;
  }
  return missed;
}

/**
 * The feed-expectation TickSource (orchestrator clock). Each tick re-derives
 * every expectation's due-miss count and emits ONE feed.expectation.missed per
 * expectation whose count grew, persisting the new count in the same
 * transaction. The persist uses a compare-and-set on the previous count so a
 * second orchestrator racing the same tick cannot double-emit.
 */
export function createFeedExpectationTickSource(db: Db, spine: EventSpine): TickSource {
  return {
    id: "connections.feed-expectations",
    async tick(now: Date): Promise<void> {
      const rows: FeedExpectationRow[] = await db.sql`
        select * from connections.feed_expectations`;
      for (const row of rows) {
        const expectation = rowToFeedExpectation(row);
        const base = new Date(expectation.lastSeenAt ?? toIso(row.created_at));
        const due = countDueMisses(expectation.expectCadence, base, now, expectation.graceMinutes);
        if (due <= expectation.missedCount) continue;
        await db.withTx(async (tx) => {
          const claimed: { id: string }[] = await txSql(tx)`
            update connections.feed_expectations
            set missed_count = ${due}, updated_at = now()
            where id = ${expectation.id} and missed_count = ${expectation.missedCount}
            returning id`;
          if (claimed.length === 0) return; // another orchestrator already flagged this occurrence
          await spine.append(tx, {
            tenantId: expectation.tenantId,
            topic: "feed.expectation.missed",
            subjectRefs: [{ kind: "connection", id: expectation.connectionId }],
            actor: { kind: "connection", id: expectation.connectionId },
            payload: { key: expectation.key, missedCount: due },
            severity: "warning",
          });
        });
      }
    },
  };
}
