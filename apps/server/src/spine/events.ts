import { eventSchema, newUlid, nowIso, validateEventPayload } from "@lithis/core";
import type { Event } from "@lithis/core";
import { txSql } from "../db";
import type { Db, DbTx } from "../db";
import { matchesSelector } from "./selector";
import type { Cursor, EventSelector, EventSpineRuntime, NewEvent, Subscription } from "./index";

/**
 * The Postgres event spine: transactional-outbox append + a polling dispatcher
 * with durable per-(consumer, tenant) cursors. Local delivery polls (Bun's SQL
 * client has no LISTEN/NOTIFY yet) with an in-process wake shortly after each
 * append for near-instant same-process delivery — correctness never depends
 * on the wake, only on the cursor scan. On GCP a SpineDriver adapter replaces
 * the loop's transport, not append (see docs/adr/001-event-spine.md).
 */

const SCAN_BATCH = 100;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
/** Delay before the post-append wake — long enough for the caller's tx to commit in the common case. */
const WAKE_DELAY_MS = 25;

interface EventRow {
  id: string;
  tenant_id: string;
  seq: bigint | number;
  topic: string;
  subject_refs: unknown;
  payload: unknown;
  actor: unknown;
  causation_id: string | null;
  correlation_id: string | null;
  severity: string | null;
  at: Date | string;
  prev_hash: string | null;
  hash: string | null;
}

/** Bun's SQL client returns jsonb columns as JSON text — parse before zod. */
function fromJsonb(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function rowToEvent(row: EventRow): Event {
  return eventSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    seq: row.seq,
    topic: row.topic,
    subjectRefs: fromJsonb(row.subject_refs),
    payload: fromJsonb(row.payload) ?? undefined,
    actor: fromJsonb(row.actor),
    ...(row.causation_id !== null ? { causationId: row.causation_id } : {}),
    ...(row.correlation_id !== null ? { correlationId: row.correlation_id } : {}),
    ...(row.severity !== null ? { severity: row.severity } : {}),
    at: row.at instanceof Date ? row.at.toISOString() : row.at,
    ...(row.prev_hash !== null ? { prevHash: row.prev_hash } : {}),
    ...(row.hash !== null ? { hash: row.hash } : {}),
  });
}

interface ActiveSubscription {
  consumerId: string;
  selector: EventSelector;
  handler: (e: Event) => Promise<void>;
}

interface BackoffState {
  untilMs: number;
  delayMs: number;
}

export function createPgEventSpine(db: Db): EventSpineRuntime {
  const subscriptions = new Map<string, ActiveSubscription>();
  const backoff = new Map<string, BackoffState>(); // key `${consumerId}\n${tenantId}`
  let timer: ReturnType<typeof setInterval> | undefined;
  let cycleInFlight: Promise<void> | undefined;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;

  async function append(tx: DbTx, e: NewEvent): Promise<Event> {
    // Throws inside the caller's transaction — nothing persists on a bad event.
    validateEventPayload(e.topic, e.payload);
    const sql = txSql(tx);
    const seqRows: { last_seq: bigint | number }[] = await sql`
      insert into spine.tenant_seq (tenant_id, last_seq) values (${e.tenantId}, 1)
      on conflict (tenant_id) do update set
        last_seq = spine.tenant_seq.last_seq + 1,
        updated_at = now()
      returning last_seq`;
    const seq = BigInt(seqRows[0]!.last_seq);
    const id = newUlid();
    const at = nowIso();
    await sql`
      insert into spine.events
        (id, tenant_id, seq, topic, subject_refs, payload, actor,
         causation_id, correlation_id, severity, at)
      values
        (${id}, ${e.tenantId}, ${seq}, ${e.topic},
         ${JSON.stringify(e.subjectRefs)}::jsonb,
         ${e.payload === undefined ? null : JSON.stringify(e.payload)}::jsonb,
         ${JSON.stringify(e.actor)}::jsonb,
         ${e.causationId ?? null}, ${e.correlationId ?? null},
         ${e.severity ?? null}, ${at})`;
    // Fast-path nudge for same-process consumers; the poll remains the truth.
    if (timer !== undefined && wakeTimer === undefined) {
      wakeTimer = setTimeout(() => {
        wakeTimer = undefined;
        void runCycle();
      }, WAKE_DELAY_MS);
    }
    return eventSchema.parse({
      id,
      tenantId: e.tenantId,
      seq,
      topic: e.topic,
      subjectRefs: e.subjectRefs,
      payload: e.payload,
      actor: e.actor,
      ...(e.causationId !== undefined ? { causationId: e.causationId } : {}),
      ...(e.correlationId !== undefined ? { correlationId: e.correlationId } : {}),
      ...(e.severity !== undefined ? { severity: e.severity } : {}),
      at,
    });
  }

  async function readSince(cursor: Cursor, sel?: EventSelector, limit = 100): Promise<Event[]> {
    // Scans up to `limit` rows past the cursor and returns the matches —
    // replay/catch-up read; never moves stored cursors.
    const rows: EventRow[] = await db.sql`
      select * from spine.events
      where tenant_id = ${cursor.tenantId} and seq > ${cursor.afterSeq}
      order by seq
      limit ${limit}`;
    const events = rows.map(rowToEvent);
    return sel === undefined ? events : events.filter((e) => matchesSelector(e, sel));
  }

  function subscribe(
    consumerId: string,
    sel: EventSelector,
    h: (e: Event) => Promise<void>,
  ): Subscription {
    if (subscriptions.has(consumerId)) {
      throw new Error(`consumer '${consumerId}' is already subscribed in this process`);
    }
    subscriptions.set(consumerId, { consumerId, selector: sel, handler: h });
    return {
      consumerId,
      selector: sel,
      close: async () => {
        subscriptions.delete(consumerId);
        await cycleInFlight;
      },
    };
  }

  async function deliverForTenant(sub: ActiveSubscription, tenantId: string): Promise<void> {
    const backoffKey = `${sub.consumerId}\n${tenantId}`;
    const state = backoff.get(backoffKey);
    if (state !== undefined && state.untilMs > Date.now()) return;

    await db.sql`
      insert into spine.consumer_cursors (consumer_id, tenant_id, after_seq, selector)
      values (${sub.consumerId}, ${tenantId}, 0, ${JSON.stringify(sub.selector)}::jsonb)
      on conflict (consumer_id, tenant_id) do nothing`;
    const cursorRows: { after_seq: bigint | number }[] = await db.sql`
      select after_seq from spine.consumer_cursors
      where consumer_id = ${sub.consumerId} and tenant_id = ${tenantId}`;
    let afterSeq = BigInt(cursorRows[0]!.after_seq);
    const startSeq = afterSeq;

    const rows: EventRow[] = await db.sql`
      select * from spine.events
      where tenant_id = ${tenantId} and seq > ${afterSeq}
      order by seq
      limit ${SCAN_BATCH}`;

    try {
      for (const row of rows) {
        const event = rowToEvent(row);
        if (matchesSelector(event, sub.selector)) {
          try {
            await sub.handler(event);
            backoff.delete(backoffKey);
          } catch (err) {
            const prev = backoff.get(backoffKey);
            const delayMs = Math.min(prev !== undefined ? prev.delayMs * 2 : BACKOFF_BASE_MS, BACKOFF_CAP_MS);
            backoff.set(backoffKey, { untilMs: Date.now() + delayMs, delayMs });
            console.error(
              `spine dispatcher: consumer '${sub.consumerId}' failed on event ${event.id} ` +
                `(topic ${event.topic}, tenant ${tenantId}) — redelivering in ${delayMs}ms:`,
              err,
            );
            break; // do not advance past the failed event (ordered at-least-once)
          }
        }
        afterSeq = event.seq; // matched-and-handled or non-match: both advance
      }
    } finally {
      if (afterSeq > startSeq) {
        await db.sql`
          update spine.consumer_cursors
          set after_seq = ${afterSeq}, updated_at = now()
          where consumer_id = ${sub.consumerId} and tenant_id = ${tenantId}`;
      }
    }
  }

  async function deliverOnce(): Promise<void> {
    if (subscriptions.size === 0) return;
    const tenants: { tenant_id: string }[] = await db.sql`select tenant_id from spine.tenant_seq`;
    for (const sub of [...subscriptions.values()]) {
      for (const t of tenants) {
        if (!subscriptions.has(sub.consumerId)) break; // closed mid-cycle
        await deliverForTenant(sub, t.tenant_id);
      }
    }
  }

  async function runCycle(): Promise<void> {
    if (cycleInFlight !== undefined) return;
    cycleInFlight = deliverOnce()
      .catch((err) => {
        console.error("spine dispatcher cycle failed:", err);
      })
      .finally(() => {
        cycleInFlight = undefined;
      });
    await cycleInFlight;
  }

  return {
    append,
    readSince,
    subscribe,
    startDispatcher(opts?: { intervalMs?: number }): void {
      if (timer !== undefined) return;
      timer = setInterval(() => void runCycle(), opts?.intervalMs ?? 300);
    },
    async stopDispatcher(): Promise<void> {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      if (wakeTimer !== undefined) {
        clearTimeout(wakeTimer);
        wakeTimer = undefined;
      }
      await cycleInFlight;
    },
  };
}
