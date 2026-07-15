import type {
  HumanRequest,
  HumanResolution,
  IsoDateTime,
  PrincipalContext,
  Ref,
  Ulid,
} from "@lithis/core";
import type { Db } from "../db";
import type { EventSpine, TickSource } from "../spine";
import { createPgHumanGate } from "./service";

/**
 * humangate — THE human-in-the-loop primitive. One request shape (approval /
 * question / notification) with evidence-first cards, routing, SLA
 * follow-ups, and escalation — reused by node gates, risky actions, outreach
 * batches, cascade plans, skill/template changes, SoR migrations, watcher
 * findings, and record-field questions. SLA machinery is for INTERNAL
 * responders only; external-party follow-ups live on WorkItem.followUp.
 */

/** The id every gated flow gets back when it asks a human. */
export type HumanRequestId = Ulid;

export type NewHumanRequest = Omit<
  HumanRequest,
  "id" | "createdAt" | "updatedAt" | "state" | "resolution"
>;

export interface InboxFilter {
  kinds?: HumanRequest["kind"][];
  subjectKinds?: HumanRequest["subjectKind"][];
  /** Default: pending only. */
  includeResolved?: boolean;
}

/** What the SLA tick decided to do (follow up / escalate / expire). */
export interface FollowUpAction {
  humanRequestId: Ulid;
  action: "follow_up" | "escalate" | "expire";
  at: IsoDateTime;
}

export interface HumanGate {
  request(r: NewHumanRequest): Promise<HumanRequest>;
  /** Tenant-scoped point lookup — server-internal consumers (delivery cards) load the full record. */
  get(id: Ulid, tenantId: Ulid): Promise<HumanRequest | undefined>;
  /** Validates the HUMAN_REQUEST_TRANSITIONS table; deny/modify triggers the Invalidator. */
  resolve(id: Ulid, res: HumanResolution, by: PrincipalContext): Promise<HumanRequest>;
  inbox(p: PrincipalContext, f?: InboxFilter): Promise<HumanRequest[]>;
  /**
   * The Invalidator's move (P8-process): every pending/approved/modified
   * request about `subject` flips to `superseded` (original approvers are
   * notified via humangate.superseded). Returns the superseded request ids.
   */
  supersedeForSubject(tenantId: Ulid, subject: Ref, causeEventId?: Ulid): Promise<Ulid[]>;
  /** Internal-responder SLA only — called by the spine clock. */
  tick(now: Date): Promise<FollowUpAction[]>;
}

export function createHumanGate(db: Db, spine: EventSpine): HumanGate {
  return createPgHumanGate(db, spine);
}

/** The clock registration for the SLA sweep (orchestrator role, db-backed boots only). */
export function slaTickSource(gate: HumanGate): TickSource {
  return {
    id: "humangate.sla",
    async tick(now: Date): Promise<void> {
      await gate.tick(now);
    },
  };
}

export { HumanRequestNotFoundError } from "./service";
