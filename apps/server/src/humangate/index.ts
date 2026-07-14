import type {
  HumanRequest,
  HumanResolution,
  IsoDateTime,
  PrincipalContext,
  Ulid,
} from "@lithis/core";
import { stubService } from "@lithis/stubkit";

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
  /** Validates the HUMAN_REQUEST_TRANSITIONS table; deny/modify triggers the Invalidator. */
  resolve(id: Ulid, res: HumanResolution, by: PrincipalContext): Promise<HumanRequest>;
  inbox(p: PrincipalContext, f?: InboxFilter): Promise<HumanRequest[]>;
  /** Internal-responder SLA only — called by the spine clock. */
  tick(now: Date): Promise<FollowUpAction[]>;
}

const humanGate = stubService<HumanGate>(
  "server.humangate.gate",
  ["request", "resolve", "inbox", "tick"],
  "LITHIS-STUB: human request lifecycle (routing, SLA follow-ups, escalation, supersession) not implemented",
);

export function createHumanGate(): HumanGate {
  return humanGate;
}
