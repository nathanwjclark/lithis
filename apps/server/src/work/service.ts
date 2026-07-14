import {
  WORK_ITEM_TRANSITIONS,
  assertTransition,
  newUlid,
  nowIso,
  workItemSchema,
  workNoteSchema,
} from "@lithis/core";
import type { PrincipalContext, RunOutcome, WorkItem, WorkItemLease, WorkItemStatus } from "@lithis/core";
import { txSql } from "../db";
import type { Db, DbTx } from "../db";
import type { EventSpine, TickSource } from "../spine";
import { OUTCOME_TO_STATUS, LeaseLostError, assertHeldLease, initialStatus } from "./state";
import type {
  ClaimFilter,
  Lease,
  NewWorkItem,
  NewWorkNote,
  WorkItemId,
  WorkQueue,
  WorkQueueOptions,
} from "./index";

/**
 * The Postgres work queue: the work_items table IS the job queue. claim() is
 * `FOR UPDATE SKIP LOCKED` over ready items by priority; a claim holds a lease
 * (`{holderPrincipalId, runId, expiresAt, heartbeatAt}`) that must be
 * heartbeated; the lease-reclaim TickSource returns expired-lease items to
 * `ready` with `attempt` preserved and flips due `wakeAt` sleepers
 * pending→ready. Every transition is validated against WORK_ITEM_TRANSITIONS
 * and emits work.item.status_changed via the transactional outbox.
 *
 * NOT here (deliberately): recurring-schedule minting of oneoff children
 * (clock cron work, deferred past P5) and any WorkEdge surface (the table
 * ships; pending→ready on depends_on completion is P8-process).
 */

const DEFAULT_LEASE_TTL_MS = 5 * 60_000;

interface LeaseOpRow {
  id: string;
  tenant_id: string;
  status: string;
  attempt: number;
  lease: unknown;
}

/** Bun's SQL client returns jsonb columns as JSON text — parse before zod. */
function fromJsonb(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

export function createPgWorkQueue(db: Db, spine: EventSpine, opts?: WorkQueueOptions): WorkQueue {
  const leaseTtlMs = opts?.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;

  /** Lock the item row for a lease operation (waits on concurrent claimers/reclaimers). */
  async function lockForLeaseOp(tx: DbTx, l: Lease, op: string): Promise<LeaseOpRow> {
    const rows: LeaseOpRow[] = await txSql(tx)`
      select id, tenant_id, status, attempt, lease from work.work_items
      where id = ${l.workItemId}
      for update`;
    const row = rows[0];
    if (row === undefined) {
      throw new LeaseLostError(`${op}: work item ${l.workItemId} does not exist`);
    }
    assertHeldLease(fromJsonb(row.lease), l, Date.now(), op);
    return row;
  }

  async function emitStatusChanged(
    tx: DbTx,
    row: { id: string; tenant_id: string },
    from: WorkItemStatus,
    to: WorkItemStatus,
    attempt: number,
    actorPrincipalId: string,
  ): Promise<void> {
    await spine.append(tx, {
      tenantId: row.tenant_id,
      topic: "work.item.status_changed",
      subjectRefs: [{ kind: "work_item", id: row.id }],
      actor: { kind: "principal", id: actorPrincipalId },
      payload: { from, to, attempt },
    });
  }

  return {
    async get(id: WorkItemId): Promise<WorkItem | null> {
      const rows: Record<string, unknown>[] = await db.sql`
        select * from work.work_items where id = ${id}`;
      const row = rows[0];
      if (row === undefined) return null;
      const toIso = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v);
      return workItemSchema.parse({
        id: row["id"],
        tenantId: row["tenant_id"],
        kind: row["kind"],
        title: row["title"],
        body: row["body"],
        status: row["status"],
        ownerPrincipalId: row["owner_principal_id"],
        priority: Number(row["priority"]),
        ...(row["due_at"] !== null ? { dueAt: toIso(row["due_at"]) } : {}),
        ...(row["wake_at"] !== null ? { wakeAt: toIso(row["wake_at"]) } : {}),
        ...(row["schedule"] !== null ? { schedule: row["schedule"] } : {}),
        ...(row["follow_up"] !== null ? { followUp: fromJsonb(row["follow_up"]) } : {}),
        ...(row["process_run_id"] !== null ? { processRunId: row["process_run_id"] } : {}),
        ...(row["node_key"] !== null ? { nodeKey: row["node_key"] } : {}),
        attempt: row["attempt"],
        ...(row["lease"] !== null ? { lease: fromJsonb(row["lease"]) } : {}),
        sourceRefs: fromJsonb(row["source_refs"]),
        revision: row["revision"],
        createdAt: toIso(row["created_at"]),
        updatedAt: toIso(row["updated_at"]),
      });
    },

    async open(item: NewWorkItem): Promise<WorkItemId> {
      const id = newUlid();
      const at = nowIso();
      const w = workItemSchema.parse({
        ...item,
        id,
        status: initialStatus(item.wakeAt, new Date()),
        attempt: 0,
        revision: 0,
        createdAt: at,
        updatedAt: at,
      });
      await db.withTx(async (tx) => {
        await txSql(tx)`
          insert into work.work_items
            (id, tenant_id, kind, title, body, status, owner_principal_id, priority,
             due_at, wake_at, schedule, follow_up, process_run_id, node_key, attempt,
             lease, source_refs, revision, created_at, updated_at)
          values
            (${w.id}, ${w.tenantId}, ${w.kind}, ${w.title}, ${w.body}, ${w.status},
             ${w.ownerPrincipalId}, ${w.priority}, ${w.dueAt ?? null}, ${w.wakeAt ?? null},
             ${w.schedule ?? null},
             ${w.followUp ?? null}::jsonb,
             ${w.processRunId ?? null}, ${w.nodeKey ?? null}, ${w.attempt},
             null, ${w.sourceRefs}::jsonb, ${w.revision}, ${at}, ${at})`;
        await spine.append(tx, {
          tenantId: w.tenantId,
          topic: "work.item.opened",
          subjectRefs: [{ kind: "work_item", id }],
          actor: { kind: "principal", id: w.ownerPrincipalId },
          payload: {
            kind: w.kind,
            ...(w.processRunId !== undefined ? { processRunId: w.processRunId } : {}),
          },
        });
      });
      return id;
    },

    async claim(p: PrincipalContext, f: ClaimFilter): Promise<Lease | null> {
      // Empty kinds list = unfiltered. Kinds are enum words, so CSV transport
      // into string_to_array is safe (Bun's SQL client cannot bind text[] yet).
      const kindsCsv = f.kinds !== undefined && f.kinds.length > 0 ? f.kinds.join(",") : null;
      return await db.withTx(async (tx) => {
        const sql = txSql(tx);
        const rows: { id: string; status: string; attempt: number }[] = await sql`
          select id, status, attempt from work.work_items
          where tenant_id = ${p.tenantId}
            and status = 'ready'
            and (${kindsCsv === null} or kind = any(string_to_array(${kindsCsv}::text, ',')))
            and (${f.processRunId === undefined} or process_run_id = ${f.processRunId ?? null})
            and (${f.ownedOnly !== true} or owner_principal_id = ${p.principalId})
          order by priority desc, id
          limit 1
          for update skip locked`;
        const row = rows[0];
        if (row === undefined) return null;
        assertTransition(WORK_ITEM_TRANSITIONS, row.status as WorkItemStatus, "claimed", "work item");
        const at = nowIso();
        const lease: WorkItemLease = {
          holderPrincipalId: p.principalId,
          runId: newUlid(),
          expiresAt: new Date(Date.now() + leaseTtlMs).toISOString(),
          heartbeatAt: at,
        };
        const attempt = row.attempt + 1;
        await sql`
          update work.work_items
          set status = 'claimed', lease = ${lease}::jsonb,
              attempt = ${attempt}, revision = revision + 1, updated_at = ${at}
          where id = ${row.id}`;
        await emitStatusChanged(
          tx,
          { id: row.id, tenant_id: p.tenantId },
          "ready",
          "claimed",
          attempt,
          p.principalId,
        );
        return { workItemId: row.id, ...lease };
      });
    },

    async heartbeat(l: Lease): Promise<void> {
      await db.withTx(async (tx) => {
        const row = await lockForLeaseOp(tx, l, "heartbeat");
        const at = nowIso();
        // Persist the core lease shape (no workItemId key) with fresh expiry.
        const leaseJson: WorkItemLease = {
          holderPrincipalId: l.holderPrincipalId,
          runId: l.runId,
          expiresAt: new Date(Date.now() + leaseTtlMs).toISOString(),
          heartbeatAt: at,
        };
        await txSql(tx)`
          update work.work_items
          set lease = ${leaseJson}::jsonb, revision = revision + 1, updated_at = ${at}
          where id = ${row.id}`;
      });
    },

    async release(l: Lease): Promise<void> {
      await db.withTx(async (tx) => {
        const row = await lockForLeaseOp(tx, l, "release");
        const from = row.status as WorkItemStatus;
        assertTransition(WORK_ITEM_TRANSITIONS, from, "ready", "work item");
        await txSql(tx)`
          update work.work_items
          set status = 'ready', lease = null, revision = revision + 1, updated_at = ${nowIso()}
          where id = ${row.id}`;
        await emitStatusChanged(tx, row, from, "ready", row.attempt, l.holderPrincipalId);
      });
    },

    async complete(l: Lease, outcome: RunOutcome): Promise<void> {
      const target = OUTCOME_TO_STATUS[outcome.status];
      await db.withTx(async (tx) => {
        const row = await lockForLeaseOp(tx, l, "complete");
        let from = row.status as WorkItemStatus;
        if (from === "claimed") {
          // A finished run definitionally passed through `running`; emit the
          // intermediate hop so the spine stays a valid transition log.
          assertTransition(WORK_ITEM_TRANSITIONS, from, "running", "work item");
          await emitStatusChanged(tx, row, from, "running", row.attempt, l.holderPrincipalId);
          from = "running";
        }
        assertTransition(WORK_ITEM_TRANSITIONS, from, target, "work item");
        await txSql(tx)`
          update work.work_items
          set status = ${target}, lease = null, revision = revision + 1, updated_at = ${nowIso()}
          where id = ${row.id}`;
        await emitStatusChanged(tx, row, from, target, row.attempt, l.holderPrincipalId);
      });
    },

    async addNote(id: WorkItemId, n: NewWorkNote): Promise<void> {
      await db.withTx(async (tx) => {
        const sql = txSql(tx);
        const rows: { tenant_id: string }[] = await sql`
          select tenant_id from work.work_items where id = ${id}`;
        const item = rows[0];
        if (item === undefined) {
          throw new Error(`addNote: work item ${id} does not exist`);
        }
        const at = nowIso();
        const note = workNoteSchema.parse({
          id: newUlid(),
          tenantId: item.tenant_id,
          workItemId: id,
          at,
          byRef: n.byRef,
          kind: n.kind,
          text: n.text,
        });
        await sql`
          insert into work.work_notes
            (id, tenant_id, work_item_id, at, by_ref, kind, text, created_at, updated_at)
          values
            (${note.id}, ${note.tenantId}, ${note.workItemId}, ${note.at},
             ${note.byRef}::jsonb, ${note.kind}, ${note.text}, ${at}, ${at})`;
        await spine.append(tx, {
          tenantId: note.tenantId,
          topic: "work.note.added",
          subjectRefs: [{ kind: "work_item", id }],
          actor: note.byRef,
          payload: { noteKind: note.kind },
        });
      });
    },
  };
}

/**
 * The clock's work TickSource: (1) items whose lease expired go back to
 * `ready` with attempt preserved; (2) `pending` sleepers whose wakeAt is due
 * flip to `ready`. Both scans SKIP LOCKED so a live claim/heartbeat
 * transaction is never fought over. System transitions have no principal
 * actor — the tenant is its own actor (the iam bootstrap precedent).
 */
export function createLeaseReclaimSource(db: Db, spine: EventSpine): TickSource {
  async function flip(
    tx: DbTx,
    row: { id: string; tenant_id: string; attempt: number },
    from: WorkItemStatus,
    clearLease: boolean,
  ): Promise<void> {
    assertTransition(WORK_ITEM_TRANSITIONS, from, "ready", "work item");
    const at = nowIso();
    if (clearLease) {
      await txSql(tx)`
        update work.work_items
        set status = 'ready', lease = null, revision = revision + 1, updated_at = ${at}
        where id = ${row.id}`;
    } else {
      await txSql(tx)`
        update work.work_items
        set status = 'ready', revision = revision + 1, updated_at = ${at}
        where id = ${row.id}`;
    }
    await spine.append(tx, {
      tenantId: row.tenant_id,
      topic: "work.item.status_changed",
      subjectRefs: [{ kind: "work_item", id: row.id }],
      actor: { kind: "tenant", id: row.tenant_id },
      payload: { from, to: "ready", attempt: row.attempt },
    });
  }

  return {
    id: "work.lease-reclaim",
    async tick(now: Date): Promise<void> {
      const nowTs = now.toISOString();
      await db.withTx(async (tx) => {
        const sql = txSql(tx);
        const expired: { id: string; tenant_id: string; status: string; attempt: number }[] = await sql`
          select id, tenant_id, status, attempt from work.work_items
          where status in ('claimed', 'running')
            and (lease ->> 'expiresAt')::timestamptz <= ${nowTs}::timestamptz
          for update skip locked`;
        for (const row of expired) {
          await flip(tx, row, row.status as WorkItemStatus, true);
        }
        const due: { id: string; tenant_id: string; attempt: number }[] = await sql`
          select id, tenant_id, attempt from work.work_items
          where status = 'pending' and wake_at is not null and wake_at <= ${nowTs}::timestamptz
          for update skip locked`;
        for (const row of due) {
          await flip(tx, row, "pending", false);
        }
      });
    },
  };
}
