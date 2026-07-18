import type {
  PrincipalContext,
  Ref,
  RunOutcome,
  Ulid,
  WorkEdge,
  WorkItem,
  WorkItemLease,
  WorkItemStatus,
  WorkNote,
} from "@lithis/core";
import type { Db } from "../db";
import type { EventSpine, TickSource } from "../spine";
import { createLeaseReclaimSource, createPgWorkQueue } from "./service";

/**
 * work — ONE work graph (pillars 3+4 merged): the global agent task list and
 * process nodes are the same table, state machine (WORK_ITEM_TRANSITIONS in
 * @lithis/core), and claim protocol. The WorkItem table IS the job queue:
 * FOR UPDATE SKIP LOCKED + lease/heartbeat; expired leases return items to
 * ready with attempt preserved (the work.lease-reclaim TickSource, which also
 * flips due wakeAt sleepers pending→ready).
 *
 * P8-process additions: the WorkEdge surface (open(…, { dependsOn }) starts an
 * item `pending` until every upstream is done; completing an item to `done`
 * promotes pending/stale dependents whose upstreams are all done) and the
 * Invalidator surface (markStale/revive/demote/revokeLease — see the doc
 * comments; the process Invalidator is the ONLY intended caller of markStale).
 *
 * Still out of scope: recurring-schedule minting of oneoff occurrence children
 * (clock cron work, deferred past P5).
 */

export type WorkItemId = Ulid;

export type NewWorkItem = Omit<
  WorkItem,
  "id" | "createdAt" | "updatedAt" | "revision" | "status" | "attempt" | "lease"
>;

/** A held claim: the core lease shape plus which item it holds. */
export type Lease = WorkItemLease & { workItemId: WorkItemId };

export interface ClaimFilter {
  kinds?: WorkItem["kind"][];
  processRunId?: Ulid;
  /** Claim only items owned by this principal (an agent working its own list). */
  ownedOnly?: boolean;
}

export type NewWorkNote = Pick<WorkNote, "byRef" | "kind" | "text">;

export interface OpenOptions {
  /** Upstream items this one depends_on; any not-yet-done upstream opens it `pending`. */
  dependsOn?: WorkItemId[];
}

/** A process run's nodes + depends_on/subtask_of edges (for cascade planning). */
export interface WorkGraph {
  items: WorkItem[];
  edges: WorkEdge[];
}

export interface WorkQueue {
  open(item: NewWorkItem, opts?: OpenOptions): Promise<WorkItemId>;
  /** Read one item (a claimed worker reading what it must do); undefined when absent. */
  get(id: WorkItemId): Promise<WorkItem | undefined>;
  /** Every process_node item of a run plus the edges among them. */
  graphForProcessRun(tenantId: Ulid, processRunId: Ulid): Promise<WorkGraph>;
  /** SKIP LOCKED claim (owner-matched items first, then priority); null when nothing is ready. */
  claim(p: PrincipalContext, f: ClaimFilter): Promise<Lease | null>;
  heartbeat(l: Lease): Promise<void>;
  release(l: Lease): Promise<void>;
  /**
   * Drives the state machine: done / awaiting_approval / blocked / failed per
   * outcome. Reaching `done` promotes pending/stale dependents whose upstreams
   * are now all done (same transaction).
   */
  complete(l: Lease, outcome: RunOutcome): Promise<void>;
  /** A human approved the gated result: awaiting_approval → done (+ dependent promotion). */
  resolveApproval(id: WorkItemId, actor: Ref): Promise<void>;
  /** Append-only journal; emits work.note.added. */
  addNote(id: WorkItemId, n: NewWorkNote): Promise<void>;
  /**
   * Change the owner (the Jira-assignee model: any actor may reassign; a wrong
   * change is on the changer — journaled as a system WorkNote). Ownership is a
   * soft claim preference, never an exclusion: claim() orders owner-matched
   * items first but any agent can still pick the item up.
   */
  reassign(id: WorkItemId, newOwnerPrincipalId: Ulid, actor: Ref): Promise<void>;

  // ── The Invalidator surface (P8-process). The Invalidator (processes module)
  //    is the ONLY writer of `stale` — nothing else should call markStale. ──
  /** done|awaiting_approval → stale. */
  markStale(id: WorkItemId, actor: Ref): Promise<void>;
  /** stale → ready when every depends_on upstream is done, else stale → pending. */
  revive(id: WorkItemId, actor: Ref): Promise<WorkItemStatus>;
  /** ready → pending (an upstream is no longer done). */
  demote(id: WorkItemId, actor: Ref): Promise<void>;
  /** claimed|running → ready with the lease cleared; the holder's next lease op throws LeaseLostError. */
  revokeLease(id: WorkItemId, actor: Ref): Promise<void>;
  /** Any live status → cancelled (lease cleared). */
  cancel(id: WorkItemId, actor: Ref): Promise<void>;
}

export interface WorkQueueOptions {
  /** How long a claim lives without a heartbeat (default 5 minutes). */
  leaseTtlMs?: number;
}

export function createWorkQueue(db: Db, spine: EventSpine, opts?: WorkQueueOptions): WorkQueue {
  return createPgWorkQueue(db, spine, opts);
}

/** The clock TickSource that reclaims expired leases and wakes due sleepers. */
export function createLeaseReclaimTickSource(db: Db, spine: EventSpine): TickSource {
  return createLeaseReclaimSource(db, spine);
}

export { LeaseLostError, OUTCOME_TO_STATUS, assertHeldLease, initialStatus } from "./state";
