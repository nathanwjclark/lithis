import {
  HUMAN_REQUEST_TRANSITIONS,
  assertTransition,
  humanRequestRoutingSchema,
  humanRequestSchema,
  humanResolutionSchema,
  newUlid,
  nowIso,
} from "@lithis/core";
import type { HumanRequest, HumanResolution, PrincipalContext, Ref, Ulid } from "@lithis/core";
import { txSql } from "../db";
import type { Db, DbTx } from "../db";
import type { EventSpine } from "../spine";
import { decideSla, isDue, nextFollowUpAt } from "./sla";
import type { FollowUpAction, HumanGate, InboxFilter, NewHumanRequest } from "./index";

/**
 * Postgres-backed HumanGate: the ONE human-in-the-loop primitive. Every state
 * change rides the transactional outbox — the humangate.* event commits with
 * the row or not at all. HUMAN_REQUEST_TRANSITIONS (core) is the law for what
 * moves are legal; the SLA sweep policy lives in ./sla.ts.
 *
 * Supersession (pending/approved/modified → superseded) is deliberately NOT
 * exposed here: per docs/concepts/human-gate.md it is the Invalidator's move
 * when a cascade invalidates the thing that was approved, and the Invalidator
 * lands with P8-process. The humangate.superseded topic is registered and
 * waiting.
 */

export class HumanRequestNotFoundError extends Error {
  constructor(readonly humanRequestId: string) {
    super(`human request ${humanRequestId} not found`);
    this.name = "HumanRequestNotFoundError";
  }
}

interface HumanRequestRow {
  id: string;
  tenant_id: string;
  kind: string;
  subject_kind: string;
  subject_ref: unknown;
  payload: unknown;
  evidence_ids: unknown;
  summary: string;
  options: unknown;
  routing: unknown;
  state: string;
  resolution: unknown;
  requested_by: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Bun's SQL client returns jsonb columns as JSON text — parse before zod. */
function fromJsonb(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function rowToHumanRequest(row: HumanRequestRow): HumanRequest {
  return humanRequestSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    subjectKind: row.subject_kind,
    subjectRef: fromJsonb(row.subject_ref),
    payload: fromJsonb(row.payload) ?? undefined,
    evidenceIds: fromJsonb(row.evidence_ids),
    summary: row.summary,
    ...(row.options !== null ? { options: fromJsonb(row.options) } : {}),
    routing: fromJsonb(row.routing),
    state: row.state,
    ...(row.resolution !== null ? { resolution: fromJsonb(row.resolution) } : {}),
    requestedBy: fromJsonb(row.requested_by),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

/**
 * Inbox visibility: a Ref assignee is that principal's request; a role-string
 * assignee is visible to every principal in the tenant until role membership
 * arrives with the policy layer (TODOS.md) — over-notifying beats a request
 * nobody can see.
 */
function assigneeMatches(assignee: Ref | string, p: PrincipalContext): boolean {
  return typeof assignee === "string" ? true : assignee.id === p.principalId;
}

export function createPgHumanGate(db: Db, spine: EventSpine): HumanGate {
  async function lockRequest(tx: DbTx, id: Ulid): Promise<HumanRequestRow | undefined> {
    const rows: HumanRequestRow[] = await txSql(tx)`
      select * from humangate.human_requests where id = ${id} for update`;
    return rows[0];
  }

  return {
    async request(r: NewHumanRequest): Promise<HumanRequest> {
      const id = newUlid();
      const at = nowIso();
      // First SLA wake: slaHours from creation, unless the caller pinned one.
      const routingIn = humanRequestRoutingSchema.parse(r.routing);
      const firstWake =
        routingIn.nextFollowUpAt === undefined
          ? nextFollowUpAt(routingIn, new Date(Date.parse(at)))
          : undefined;
      const routing = {
        ...routingIn,
        ...(firstWake !== undefined ? { nextFollowUpAt: firstWake } : {}),
      };
      const request = humanRequestSchema.parse({
        ...r,
        id,
        routing,
        state: "pending",
        createdAt: at,
        updatedAt: at,
      });
      await db.withTx(async (tx) => {
        await txSql(tx)`
          insert into humangate.human_requests
            (id, tenant_id, kind, subject_kind, subject_ref, payload, evidence_ids,
             summary, options, routing, state, resolution, requested_by, created_at, updated_at)
          values
            (${id}, ${request.tenantId}, ${request.kind}, ${request.subjectKind},
             ${JSON.stringify(request.subjectRef)}::text::jsonb,
             ${request.payload === undefined ? null : JSON.stringify(request.payload)}::text::jsonb,
             ${JSON.stringify(request.evidenceIds)}::text::jsonb,
             ${request.summary},
             ${request.options === undefined ? null : JSON.stringify(request.options)}::text::jsonb,
             ${JSON.stringify(request.routing)}::text::jsonb,
             ${request.state}, null,
             ${JSON.stringify(request.requestedBy)}::text::jsonb,
             ${at}, ${at})`;
        await spine.append(tx, {
          tenantId: request.tenantId,
          topic: "humangate.requested",
          subjectRefs: [{ kind: "human_request", id }, request.subjectRef],
          actor: request.requestedBy,
          payload: { kind: request.kind, subjectKind: request.subjectKind },
        });
      });
      return request;
    },

    async resolve(id: Ulid, res: HumanResolution, by: PrincipalContext): Promise<HumanRequest> {
      const resolution = humanResolutionSchema.parse(res);
      return await db.withTx(async (tx) => {
        const row = await lockRequest(tx, id);
        if (row === undefined || row.tenant_id !== by.tenantId) {
          throw new HumanRequestNotFoundError(id);
        }
        const current = rowToHumanRequest(row);
        // Resolution verdicts are a subset of states; the transition table is the law —
        // resolving an already-resolved/expired/superseded request throws here.
        const nextState = resolution.verdict;
        assertTransition(HUMAN_REQUEST_TRANSITIONS, current.state, nextState, "human request");
        const at = nowIso();
        await txSql(tx)`
          update humangate.human_requests
          set state = ${nextState},
              resolution = ${JSON.stringify(resolution)}::text::jsonb,
              updated_at = ${at}
          where id = ${id}`;
        await spine.append(tx, {
          tenantId: current.tenantId,
          topic: "humangate.resolved",
          subjectRefs: [{ kind: "human_request", id }, current.subjectRef],
          actor: resolution.by,
          payload: { verdict: resolution.verdict },
        });
        return humanRequestSchema.parse({
          ...current,
          state: nextState,
          resolution,
          updatedAt: at,
        });
      });
    },

    async inbox(p: PrincipalContext, f?: InboxFilter): Promise<HumanRequest[]> {
      const rows: HumanRequestRow[] =
        f?.includeResolved === true
          ? await db.sql`
              select * from humangate.human_requests
              where tenant_id = ${p.tenantId}
              order by created_at, id`
          : await db.sql`
              select * from humangate.human_requests
              where tenant_id = ${p.tenantId} and state = 'pending'
              order by created_at, id`;
      return rows.map(rowToHumanRequest).filter((r) => {
        if (f?.kinds !== undefined && !f.kinds.includes(r.kind)) return false;
        if (f?.subjectKinds !== undefined && !f.subjectKinds.includes(r.subjectKind)) return false;
        return assigneeMatches(r.routing.assignee, p);
      });
    },

    async tick(now: Date): Promise<FollowUpAction[]> {
      const atIso = now.toISOString();
      // Uses the partial index on (routing->>'nextFollowUpAt') where state='pending';
      // ISO-8601 UTC strings compare correctly as text. The sweep is global — the
      // clock (orchestrator role) drives every tenant.
      const due: { id: string }[] = await db.sql`
        select id from humangate.human_requests
        where state = 'pending'
          and (routing ->> 'nextFollowUpAt') is not null
          and (routing ->> 'nextFollowUpAt') <= ${atIso}
        order by (routing ->> 'nextFollowUpAt'), id`;

      const actions: FollowUpAction[] = [];
      for (const { id } of due) {
        // One transaction per request: a failure (or a racing resolve) on one
        // never rolls back the others.
        const action = await db.withTx(async (tx): Promise<FollowUpAction | undefined> => {
          const row = await lockRequest(tx, id);
          if (row === undefined) return undefined;
          const req = rowToHumanRequest(row);
          if (req.state !== "pending" || !isDue(req.routing, now)) return undefined; // resolved since the scan
          const decision = decideSla(req.routing, now);
          const subjectRefs: Ref[] = [{ kind: "human_request", id: req.id }, req.subjectRef];
          // The sweep is the system acting — same convention as iam bootstrap.
          const actor: Ref = { kind: "tenant", id: req.tenantId };
          const sql = txSql(tx);
          if (decision.action === "expire") {
            assertTransition(HUMAN_REQUEST_TRANSITIONS, req.state, "expired", "human request");
            await sql`
              update humangate.human_requests
              set state = 'expired', routing = ${JSON.stringify(decision.routing)}::text::jsonb, updated_at = ${atIso}
              where id = ${id}`;
            await spine.append(tx, {
              tenantId: req.tenantId,
              topic: "humangate.expired",
              subjectRefs,
              actor,
              severity: "warning",
              payload: { followUpCount: decision.routing.followUpCount },
            });
          } else {
            await sql`
              update humangate.human_requests
              set routing = ${JSON.stringify(decision.routing)}::text::jsonb, updated_at = ${atIso}
              where id = ${id}`;
            await spine.append(
              tx,
              decision.action === "follow_up"
                ? {
                    tenantId: req.tenantId,
                    topic: "humangate.follow_up",
                    subjectRefs,
                    actor,
                    payload: { followUpCount: decision.routing.followUpCount },
                  }
                : {
                    tenantId: req.tenantId,
                    topic: "humangate.escalated",
                    subjectRefs,
                    actor,
                    severity: "warning",
                    payload: {
                      followUpCount: decision.routing.followUpCount,
                      assignee: decision.routing.assignee,
                    },
                  },
            );
          }
          return { humanRequestId: req.id, action: decision.action, at: atIso };
        });
        if (action !== undefined) actions.push(action);
      }
      return actions;
    },
  };
}
