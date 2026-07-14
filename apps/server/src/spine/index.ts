import type { Event, RefKind } from "@lithis/core";
import { stubService } from "@lithis/stubkit";

/**
 * spine — the append-only event log: simultaneously audit trail, trigger bus,
 * watcher surface, cost ledger, and eval-replay substrate. Every mutation
 * writes its Event rows in the same transaction (transactional outbox); the
 * dispatcher (orchestrator role) delivers to durable cursor-checkpointed
 * at-least-once subscriptions. The clock (one loop, orchestrator role) is the
 * single tick source for schedules, follow-up wakes, feed grace windows, and
 * HumanRequest SLAs.
 */

/** Opaque handle to the transaction a mutation is writing in (outbox contract). */
export interface DbTx {
  readonly __brand: "DbTx";
}

/** A new event before the outbox assigns id/seq/at (and optional hash chain). */
export type NewEvent = Omit<Event, "id" | "seq" | "at" | "prevHash" | "hash">;

/** What a consumer wants to see. Empty selector = everything. */
export interface EventSelector {
  /** Dot-namespaced topic globs, e.g. "context.doc.*". */
  topics?: string[];
  subjectKinds?: RefKind[];
}

/** Durable consumer checkpoint. */
export interface Cursor {
  consumerId: string;
  afterSeq: bigint;
}

export interface Subscription {
  consumerId: string;
  selector: EventSelector;
  close(): Promise<void>;
}

export interface EventSpine {
  /** Transactional outbox append — the event commits with the mutation or not at all. */
  append(tx: DbTx, e: NewEvent): Promise<Event>;
  /** Durable at-least-once subscription, checkpointed per consumerId. */
  subscribe(consumerId: string, sel: EventSelector, h: (e: Event) => Promise<void>): Subscription;
  /** Replay/catch-up read from a cursor. */
  readSince(cursor: Cursor, sel?: EventSelector, limit?: number): Promise<Event[]>;
}

/**
 * The single tick source (orchestrator role): recurring WorkItem schedules,
 * followUp.nextAt wakes, FeedExpectation grace windows, HumanRequest SLA
 * follow-ups/escalations — one loop calls tick, domains react to the events.
 */
export interface Clock {
  tick(now: Date): Promise<void>;
}

const eventSpine = stubService<EventSpine>(
  "server.spine.events",
  ["append", "subscribe", "readSince"],
  "LITHIS-STUB: transactional outbox + dispatcher + cursor-checkpointed subscriptions not implemented",
);

const clock = stubService<Clock>(
  "server.spine.clock",
  ["tick"],
  "LITHIS-STUB: the clock loop (schedules, wakes, grace windows, SLA ticks) not implemented",
);

export function createEventSpine(): EventSpine {
  return eventSpine;
}

export function createClock(): Clock {
  return clock;
}
