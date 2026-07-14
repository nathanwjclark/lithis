import type { Event, RefKind, Ulid } from "@lithis/core";
import type { Db, DbTx } from "../db";
import { createClockRuntime } from "./clock";
import { createPgEventSpine } from "./events";

/**
 * spine — the append-only event log: simultaneously audit trail, trigger bus,
 * watcher surface, cost ledger, and eval-replay substrate. Every mutation
 * writes its Event rows in the same transaction (transactional outbox); the
 * dispatcher (orchestrator role) delivers to durable cursor-checkpointed
 * at-least-once subscriptions. The clock (one loop, orchestrator role) is the
 * single tick source for schedules, follow-up wakes, feed grace windows, and
 * HumanRequest SLAs.
 */

export type { DbTx } from "../db";

/** A new event before the outbox assigns id/seq/at (and optional hash chain). */
export type NewEvent = Omit<Event, "id" | "seq" | "at" | "prevHash" | "hash">;

/** What a consumer wants to see. Empty selector = everything. */
export interface EventSelector {
  /** Dot-namespaced topic globs, e.g. "context.doc.*" (see ./selector.ts for semantics). */
  topics?: string[];
  subjectKinds?: RefKind[];
}

/** Durable consumer checkpoint — cursors are per (consumer, tenant). */
export interface Cursor {
  consumerId: string;
  tenantId: Ulid;
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
  /** Durable at-least-once subscription, checkpointed per (consumerId, tenant). */
  subscribe(consumerId: string, sel: EventSelector, h: (e: Event) => Promise<void>): Subscription;
  /** Replay/catch-up read from a cursor. Never moves stored cursors. */
  readSince(cursor: Cursor, sel?: EventSelector, limit?: number): Promise<Event[]>;
}

/**
 * The runtime face of the spine: the polling dispatcher loop lives behind
 * start/stop so the GCP SpineDriver adapter can later replace the transport
 * without touching append.
 */
export interface EventSpineRuntime extends EventSpine {
  startDispatcher(opts?: { intervalMs?: number }): void;
  /** Stops the loop and drains the in-flight delivery cycle. */
  stopDispatcher(): Promise<void>;
}

/**
 * The single tick source (orchestrator role): recurring WorkItem schedules,
 * followUp.nextAt wakes, FeedExpectation grace windows, HumanRequest SLA
 * follow-ups/escalations — one loop calls tick, domains react to the events.
 */
export interface Clock {
  tick(now: Date): Promise<void>;
}

/** A domain's periodic work, registered with the clock (work/humangate/connections in later phases). */
export interface TickSource {
  id: string;
  tick(now: Date): Promise<void>;
}

export interface ClockRuntime extends Clock {
  registerSource(s: TickSource): void;
  start(opts?: { intervalMs?: number }): void;
  stop(): void;
}

export function createEventSpine(db: Db): EventSpineRuntime {
  return createPgEventSpine(db);
}

export function createClock(): ClockRuntime {
  return createClockRuntime();
}
