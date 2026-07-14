import type {
  PrincipalContext,
  RunOutcome,
  Ulid,
  WorkItem,
  WorkItemLease,
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
 * Out of scope until later phases: recurring-schedule minting of oneoff
 * occurrence children (clock cron work) and any WorkEdge surface — the
 * work_edges table ships, but pending→ready on depends_on completion is
 * P8-process.
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

export interface WorkQueue {
  open(item: NewWorkItem): Promise<WorkItemId>;
  /** Read one item (a claimed worker reading what it must do); null when absent. */
  get(id: WorkItemId): Promise<WorkItem | null>;
  /** SKIP LOCKED claim; null when nothing is ready. */
  claim(p: PrincipalContext, f: ClaimFilter): Promise<Lease | null>;
  heartbeat(l: Lease): Promise<void>;
  release(l: Lease): Promise<void>;
  /** Drives the state machine: done / awaiting_approval / blocked / failed per outcome. */
  complete(l: Lease, outcome: RunOutcome): Promise<void>;
  /** Append-only journal; emits work.note.added. */
  addNote(id: WorkItemId, n: NewWorkNote): Promise<void>;
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
