import {
  WORK_ITEM_TRANSITIONS,
  assertTransition,
  newUlid,
  nowIso,
  workEdgeSchema,
  workItemSchema,
  workNoteSchema,
} from "@lithis/core";
import type {
  PrincipalContext,
  Ref,
  RunOutcome,
  Ulid,
  WorkEdge,
  WorkItem,
  WorkItemLease,
  WorkItemStatus,
} from "@lithis/core";
import { txSql } from "../db";
import type { Db, DbTx } from "../db";
import type { EventSpine, TickSource } from "../spine";
import { OUTCOME_TO_STATUS, LeaseLostError, assertHeldLease, initialStatus } from "./state";
import type {
  ClaimFilter,
  Lease,
  NewWorkItem,
  NewWorkNote,
  OpenOptions,
  WorkGraph,
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
 * P8-process: the WorkEdge surface is live — open(…, { dependsOn }) parks an
 * item `pending` behind unfinished upstreams; done-completion (complete or
 * resolveApproval) promotes pending/stale dependents whose upstreams are all
 * done, in the same transaction. markStale/revive/demote/revokeLease/cancel
 * are the Invalidator's moves (processes module).
 *
 * NOT here (deliberately): recurring-schedule minting of oneoff children
 * (clock cron work, deferred past P5).
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

interface WorkItemRow {
  id: string;
  tenant_id: string;
  kind: string;
  title: string;
  body: string;
  status: string;
  owner_principal_id: string;
  priority: string | number; // numeric comes back as text
  due_at: Date | string | null;
  wake_at: Date | string | null;
  schedule: string | null;
  follow_up: unknown;
  process_run_id: string | null;
  node_key: string | null;
  attempt: number;
  lease: unknown;
  source_refs: unknown;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToWorkItem(row: WorkItemRow): WorkItem {
  return workItemSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    status: row.status,
    ownerPrincipalId: row.owner_principal_id,
    priority: Number(row.priority),
    ...(row.due_at !== null ? { dueAt: toIso(row.due_at) } : {}),
    ...(row.wake_at !== null ? { wakeAt: toIso(row.wake_at) } : {}),
    ...(row.schedule !== null ? { schedule: row.schedule } : {}),
    ...(row.follow_up !== null ? { followUp: fromJsonb(row.follow_up) } : {}),
    ...(row.process_run_id !== null ? { processRunId: row.process_run_id } : {}),
    ...(row.node_key !== null ? { nodeKey: row.node_key } : {}),
    attempt: row.attempt,
    ...(row.lease !== null ? { lease: fromJsonb(row.lease) } : {}),
    sourceRefs: fromJsonb(row.source_refs),
    revision: row.revision,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

class WorkItemNotFoundError extends Error {
  constructor(op: string, id: string) {
    super(`${op}: work item ${id} does not exist`);
    this.name = "WorkItemNotFoundError";
  }
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
    actor: Ref | string,
  ): Promise<void> {
    await spine.append(tx, {
      tenantId: row.tenant_id,
      topic: "work.item.status_changed",
      subjectRefs: [{ kind: "work_item", id: row.id }],
      actor: typeof actor === "string" ? { kind: "principal", id: actor } : actor,
      payload: { from, to, attempt },
    });
  }

  /** Lock the item row for a direct (non-lease) transition. */
  async function lockItem(tx: DbTx, id: WorkItemId, op: string): Promise<WorkItemRow> {
    const rows: WorkItemRow[] = await txSql(tx)`
      select * from work.work_items where id = ${id} for update`;
    const row = rows[0];
    if (row === undefined) throw new WorkItemNotFoundError(op, id);
    return row;
  }

  /** True when every depends_on upstream of the item is done. */
  async function upstreamsDone(tx: DbTx, id: WorkItemId): Promise<boolean> {
    const unmet: unknown[] = await txSql(tx)`
      select 1 from work.work_edges e
      join work.work_items u on u.id = e.to_id
      where e.from_id = ${id} and e.verb = 'depends_on' and u.status <> 'done'
      limit 1`;
    return unmet.length === 0;
  }

  /**
   * Apply a validated transition + emit its event. Clears the lease when the
   * target is not claimed/running (a lease only rides live executions).
   */
  async function transitionLocked(
    tx: DbTx,
    row: WorkItemRow,
    to: WorkItemStatus,
    actor: Ref | string,
  ): Promise<void> {
    const from = row.status as WorkItemStatus;
    assertTransition(WORK_ITEM_TRANSITIONS, from, to, "work item");
    await txSql(tx)`
      update work.work_items
      set status = ${to}, lease = null, revision = revision + 1, updated_at = ${nowIso()}
      where id = ${row.id}`;
    await emitStatusChanged(tx, row, from, to, row.attempt, actor);
  }

  /** Append a journal note + its work.note.added event inside the caller's tx. */
  async function insertNote(
    tx: DbTx,
    workItemId: WorkItemId,
    tenantId: string,
    n: NewWorkNote,
  ): Promise<void> {
    const at = nowIso();
    const note = workNoteSchema.parse({
      id: newUlid(),
      tenantId,
      workItemId,
      at,
      byRef: n.byRef,
      kind: n.kind,
      text: n.text,
    });
    await txSql(tx)`
      insert into work.work_notes
        (id, tenant_id, work_item_id, at, by_ref, kind, text, created_at, updated_at)
      values
        (${note.id}, ${note.tenantId}, ${note.workItemId}, ${note.at},
         ${note.byRef}::jsonb, ${note.kind}, ${note.text}, ${at}, ${at})`;
    await spine.append(tx, {
      tenantId: note.tenantId,
      topic: "work.note.added",
      subjectRefs: [{ kind: "work_item", id: workItemId }],
      actor: note.byRef,
      payload: { noteKind: note.kind },
    });
  }

  /**
   * After an item reached `done`: dependents sitting pending/stale whose
   * depends_on upstreams are now ALL done flip to ready (same transaction).
   */
  async function promoteDependents(tx: DbTx, id: WorkItemId, actor: Ref | string): Promise<void> {
    const dependents: WorkItemRow[] = await txSql(tx)`
      select w.* from work.work_edges e
      join work.work_items w on w.id = e.from_id
      where e.to_id = ${id} and e.verb = 'depends_on' and w.status in ('pending', 'stale')
      order by w.id
      for update of w`;
    for (const dep of dependents) {
      if (await upstreamsDone(tx, dep.id)) {
        await transitionLocked(tx, dep, "ready", actor);
      }
    }
  }

  return {
    async open(item: NewWorkItem, opts?: OpenOptions): Promise<WorkItemId> {
      const id = newUlid();
      const at = nowIso();
      const dependsOn = [...new Set(opts?.dependsOn ?? [])];
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
        if (dependsOn.length > 0) {
          // Lock upstreams so a concurrent complete() cannot race the initial
          // status decision; any not-yet-done upstream parks the item pending.
          const upstreams: { id: string; status: string }[] = await txSql(tx)`
            select id, status from work.work_items
            where id = any(string_to_array(${dependsOn.join(",")}::text, ','))
            order by id
            for update`;
          if (upstreams.length !== dependsOn.length) {
            const found = new Set(upstreams.map((u) => u.id));
            const missing = dependsOn.filter((d) => !found.has(d));
            throw new WorkItemNotFoundError("open dependsOn", missing.join(", "));
          }
          if (upstreams.some((u) => u.status !== "done")) {
            w.status = "pending";
          }
        }
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
        for (const upstreamId of dependsOn) {
          await txSql(tx)`
            insert into work.work_edges (id, tenant_id, from_id, to_id, verb, created_at, updated_at)
            values (${newUlid()}, ${w.tenantId}, ${id}, ${upstreamId}, 'depends_on', ${at}, ${at})`;
        }
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
          order by (owner_principal_id = ${p.principalId}) desc, priority desc, id
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
        if (target === "done") {
          await promoteDependents(tx, row.id, { kind: "principal", id: l.holderPrincipalId });
        }
      });
    },

    async resolveApproval(id: WorkItemId, actor: Ref): Promise<void> {
      await db.withTx(async (tx) => {
        const row = await lockItem(tx, id, "resolveApproval");
        await transitionLocked(tx, row, "done", actor);
        await promoteDependents(tx, id, actor);
      });
    },

    async get(id: WorkItemId): Promise<WorkItem | undefined> {
      const rows: WorkItemRow[] = await db.sql`
        select * from work.work_items where id = ${id}`;
      const row = rows[0];
      return row === undefined ? undefined : rowToWorkItem(row);
    },

    async graphForProcessRun(tenantId: Ulid, processRunId: Ulid): Promise<WorkGraph> {
      const itemRows: WorkItemRow[] = await db.sql`
        select * from work.work_items
        where tenant_id = ${tenantId} and process_run_id = ${processRunId}
        order by id`;
      const items = itemRows.map(rowToWorkItem);
      const ids = new Set(items.map((i) => i.id));
      interface EdgeRow {
        id: string;
        tenant_id: string;
        from_id: string;
        to_id: string;
        verb: string;
        created_at: Date | string;
        updated_at: Date | string;
      }
      const edgeRows: EdgeRow[] = await db.sql`
        select e.* from work.work_edges e
        join work.work_items w on w.id = e.from_id
        where e.tenant_id = ${tenantId} and w.process_run_id = ${processRunId}
        order by e.id`;
      const edges: WorkEdge[] = edgeRows
        .filter((e) => ids.has(e.to_id))
        .map((e) =>
          workEdgeSchema.parse({
            id: e.id,
            tenantId: e.tenant_id,
            fromId: e.from_id,
            toId: e.to_id,
            verb: e.verb,
            createdAt: toIso(e.created_at),
            updatedAt: toIso(e.updated_at),
          }),
        );
      return { items, edges };
    },

    async markStale(id: WorkItemId, actor: Ref): Promise<void> {
      await db.withTx(async (tx) => {
        const row = await lockItem(tx, id, "markStale");
        await transitionLocked(tx, row, "stale", actor);
      });
    },

    async revive(id: WorkItemId, actor: Ref): Promise<WorkItemStatus> {
      return await db.withTx(async (tx) => {
        const row = await lockItem(tx, id, "revive");
        const target: WorkItemStatus = (await upstreamsDone(tx, id)) ? "ready" : "pending";
        await transitionLocked(tx, row, target, actor);
        return target;
      });
    },

    async demote(id: WorkItemId, actor: Ref): Promise<void> {
      await db.withTx(async (tx) => {
        const row = await lockItem(tx, id, "demote");
        await transitionLocked(tx, row, "pending", actor);
      });
    },

    async revokeLease(id: WorkItemId, actor: Ref): Promise<void> {
      await db.withTx(async (tx) => {
        const row = await lockItem(tx, id, "revokeLease");
        await transitionLocked(tx, row, "ready", actor);
      });
    },

    async cancel(id: WorkItemId, actor: Ref): Promise<void> {
      await db.withTx(async (tx) => {
        const row = await lockItem(tx, id, "cancel");
        await transitionLocked(tx, row, "cancelled", actor);
      });
    },

    async reassign(id: WorkItemId, newOwnerPrincipalId: Ulid, actor: Ref): Promise<void> {
      await db.withTx(async (tx) => {
        const row = await lockItem(tx, id, "reassign");
        if (row.owner_principal_id === newOwnerPrincipalId) return;
        const at = nowIso();
        await txSql(tx)`
          update work.work_items
          set owner_principal_id = ${newOwnerPrincipalId},
              revision = revision + 1, updated_at = ${at}
          where id = ${id}`;
        // The change is journaled, not gated: any principal may reassign (a
        // wrong change is on the changer — the Jira-assignee model).
        await insertNote(tx, id, row.tenant_id, {
          byRef: actor,
          kind: "system",
          text: `owner reassigned: ${row.owner_principal_id} → ${newOwnerPrincipalId}`,
        });
      });
    },

    // ── P10-skills read/advance surface ──────────────────────────────────

    async listRecent(
      tenantId: Ulid,
      opts: { since: string; limit?: number },
    ): Promise<WorkItem[]> {
      const limit = opts.limit ?? 100;
      const rows: WorkItemRow[] = await db.sql`
        select * from work.work_items
        where tenant_id = ${tenantId} and updated_at >= ${opts.since}::timestamptz
        order by updated_at desc, id desc
        limit ${limit}`;
      return rows.map(rowToWorkItem);
    },

    async dueFollowUps(tenantId: Ulid, now: string): Promise<WorkItem[]> {
      const rows: WorkItemRow[] = await db.sql`
        select * from work.work_items
        where tenant_id = ${tenantId}
          and follow_up is not null
          and (follow_up ->> 'nextAt')::timestamptz <= ${now}::timestamptz
          and status not in ('done', 'cancelled')
        order by id`;
      return rows.map(rowToWorkItem);
    },

    async recordFollowUpContact(
      id: WorkItemId,
      lastContactAt: string,
      nextAt: string,
    ): Promise<void> {
      await db.withTx(async (tx) => {
        const row = await lockItem(tx, id, "recordFollowUpContact");
        const followUp = fromJsonb(row.follow_up);
        if (followUp === null || followUp === undefined) {
          throw new Error(`recordFollowUpContact: work item ${id} has no followUp`);
        }
        const next = { ...(followUp as Record<string, unknown>), lastContactAt, nextAt };
        await txSql(tx)`
          update work.work_items
          set follow_up = ${JSON.stringify(next)}::text::jsonb,
              revision = revision + 1, updated_at = ${nowIso()}
          where id = ${id}`;
      });
    },

    async addNote(id: WorkItemId, n: NewWorkNote): Promise<void> {
      await db.withTx(async (tx) => {
        const rows: { tenant_id: string }[] = await txSql(tx)`
          select tenant_id from work.work_items where id = ${id}`;
        const item = rows[0];
        if (item === undefined) {
          throw new Error(`addNote: work item ${id} does not exist`);
        }
        await insertNote(tx, id, item.tenant_id, n);
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
