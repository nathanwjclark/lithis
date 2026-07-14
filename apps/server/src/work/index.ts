import type {
  PrincipalContext,
  RunOutcome,
  Ulid,
  WorkItem,
  WorkItemLease,
  WorkNote,
} from "@lithis/core";
import { stubService } from "@lithis/stubkit";

/**
 * work — ONE work graph (pillars 3+4 merged): the global agent task list and
 * process nodes are the same table, state machine (WORK_ITEM_TRANSITIONS in
 * @lithis/core), and claim protocol. The WorkItem table IS the job queue:
 * FOR UPDATE SKIP LOCKED + lease/heartbeat; expired leases return items to
 * ready with attempt preserved.
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
  /** SKIP LOCKED claim; null when nothing is ready. */
  claim(p: PrincipalContext, f: ClaimFilter): Promise<Lease | null>;
  heartbeat(l: Lease): Promise<void>;
  release(l: Lease): Promise<void>;
  /** Drives the state machine: done / awaiting_approval / blocked / failed per outcome. */
  complete(l: Lease, outcome: RunOutcome): Promise<void>;
  /** Append-only journal; emits work.note.added. */
  addNote(id: WorkItemId, n: NewWorkNote): Promise<void>;
}

const workQueue = stubService<WorkQueue>(
  "server.work.queue",
  ["open", "claim", "heartbeat", "release", "complete", "addNote"],
  "LITHIS-STUB: SKIP LOCKED work queue (leases, heartbeats, state machine, notes) not implemented",
);

export function createWorkQueue(): WorkQueue {
  return workQueue;
}
