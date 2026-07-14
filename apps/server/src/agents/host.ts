import { cronMatches, newUlid, nowIso } from "@lithis/core";
import type { AgentCharter, Cost, PrincipalContext, RunBrief, Ulid } from "@lithis/core";
import type { Db } from "../db";
import type { EventSpine, Subscription, TickSource } from "../spine";
import type { IdentityService } from "../iam";
import type { Lease, WorkQueue } from "../work";
import {
  ZERO_COST,
  addCost,
  closeLoopSession,
  finishRun,
  openLoopSession,
  startRun,
  sumRunUsdSince,
} from "./store";
import { inputsHashFor } from "./executor";
import type {
  AgentExecutor,
  AgentHandle,
  AgentHost,
  AgentRunOutcome,
  AgentStatus,
  WakeReason,
} from "./index";

/**
 * The AgentHost — resident daemons per charter. The host delivers wake
 * reasons (heartbeat cron via the clock TickSource, charter onEvents via
 * durable spine subscriptions, message/manual via wake()) and enforces
 * budgets; the loop inside a wake is: open Session → drain claimable work
 * (one Run per item, lease heartbeated while the run is in flight, aborted on
 * lease loss) → close Session with the aggregate cost and the next heartbeat
 * wake. Concurrent wakes coalesce: a wake during a running loop queues one
 * re-run of the loop, never a parallel loop.
 *
 * Daily budget (charter.budgets.usdPerDay) is a projection over the agents'
 * own run rows (UTC day); per-run budget is min(usdPerRun, remaining day
 * budget) and is enforced mid-run by the executor.
 */

const DEFAULT_LEASE_HEARTBEAT_MS = 60_000;
const DEFAULT_RUN_MAX_MINUTES = 15;
/** How far ahead the sleeping agent searches for its next heartbeat match. */
const NEXT_WAKE_SCAN_MINUTES = 60 * 48;

export interface ResidentAgentHostDeps {
  db: Db;
  spine: EventSpine;
  identity: IdentityService;
  workQueue: WorkQueue;
  executor: AgentExecutor;
  /** The model the executor actually runs (recorded on run rows). Charter
   * modelPolicy remains the design surface; per-charter model routing is a
   * later refinement. */
  model: string;
  leaseHeartbeatMs?: number;
  runMaxMinutes?: number;
}

interface Resident {
  charter: AgentCharter;
  status: AgentStatus;
  sessionId?: Ulid;
  loopInFlight?: Promise<void>;
  pendingWake?: WakeReason;
  subscription?: Subscription;
  lastHeartbeatMinute?: string;
}

/** Next minute (within the scan window) at which the cron fires, if any. */
export function nextCronWake(cron: string, from: Date): string | undefined {
  const base = new Date(from);
  base.setSeconds(0, 0);
  for (let i = 1; i <= NEXT_WAKE_SCAN_MINUTES; i++) {
    const candidate = new Date(base.getTime() + i * 60_000);
    if (cronMatches(cron, candidate)) return candidate.toISOString();
  }
  return undefined;
}

function startOfUtcDay(now: Date): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export function createResidentAgentHost(deps: ResidentAgentHostDeps): {
  host: AgentHost;
  heartbeatTickSource: TickSource;
} {
  const leaseHeartbeatMs = deps.leaseHeartbeatMs ?? DEFAULT_LEASE_HEARTBEAT_MS;
  const runMaxMinutes = deps.runMaxMinutes ?? DEFAULT_RUN_MAX_MINUTES;
  const residents = new Map<Ulid, Resident>();

  function buildBrief(
    charter: AgentCharter,
    lease: Lease,
    item: { title: string; body: string },
    budgetUsd: number,
  ): RunBrief {
    // Memory notebook deliberately absent — see the registered stub
    // server.agents.host.memory (ContextStore has no blob-read surface yet).
    const contextSlice = [
      `## Your charter`,
      `Role: ${charter.role}`,
      ``,
      `## Work item ${lease.workItemId}`,
      `Title: ${item.title}`,
      item.body.length > 0 ? `Body:\n${item.body}` : `(no body)`,
    ].join("\n");
    return {
      tenantId: charter.tenantId,
      principalId: charter.principalId,
      workItemId: lease.workItemId,
      contextSlice,
      budget: { usd: budgetUsd, maxMinutes: runMaxMinutes },
    };
  }

  async function loadItem(lease: Lease): Promise<{ title: string; body: string }> {
    const item = await deps.workQueue.get(lease.workItemId);
    return item ?? { title: "(missing work item)", body: "" };
  }

  async function runOne(resident: Resident, sessionId: Ulid, lease: Lease): Promise<Cost> {
    const charter = resident.charter;
    const spentToday = await sumRunUsdSince(
      deps.db,
      charter.tenantId,
      charter.principalId,
      startOfUtcDay(new Date()),
    );
    const remainingDay = charter.budgets.usdPerDay - spentToday;
    const budgetUsd = Math.min(charter.budgets.usdPerRun, remainingDay);
    const item = await loadItem(lease);
    const brief = buildBrief(charter, lease, item, budgetUsd);

    const run = await startRun(deps.db, deps.spine, {
      tenantId: charter.tenantId,
      principalId: charter.principalId,
      sessionId,
      workItemId: lease.workItemId,
      model: deps.model,
      cause: "event",
    });

    // Lease discipline: heartbeat while the run is in flight; a lost lease
    // (reclaimed by the clock, revoked by a cascade) aborts the run.
    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      deps.workQueue.heartbeat(lease).catch(() => {
        controller.abort();
      });
    }, leaseHeartbeatMs);

    let outcome: AgentRunOutcome;
    try {
      outcome = await deps.executor.execute(brief, controller.signal);
    } catch (err) {
      outcome = {
        status: "failed",
        blocker: `executor threw: ${err instanceof Error ? err.message : String(err)}`,
        evidenceDrafts: [],
        newTasks: [],
        cost: ZERO_COST,
      };
    } finally {
      clearInterval(heartbeat);
    }

    await finishRun(deps.db, deps.spine, run, outcome, {
      ...(outcome.transcriptRef !== undefined ? { transcriptBlobId: outcome.transcriptRef } : {}),
      inputsHash: inputsHashFor(brief),
    });

    // Agent-proposed follow-ups become real work items.
    for (const task of outcome.newTasks) {
      await deps.workQueue.open({
        tenantId: charter.tenantId,
        kind: "oneoff",
        title: task.title,
        body: task.body,
        ownerPrincipalId: charter.principalId,
        priority: task.priority ?? 0.5,
        sourceRefs: [{ kind: "run", id: run.id }],
      });
    }

    try {
      if (controller.signal.aborted) {
        // The lease is gone — the reclaim tick owns the item's fate now.
      } else {
        await deps.workQueue.complete(lease, outcome);
      }
    } catch {
      // Lease lost between the run and completion — the reclaimer owns it.
    }
    return outcome.cost;
  }

  async function loopOnce(resident: Resident, reason: WakeReason): Promise<void> {
    const charter = resident.charter;
    const session = await openLoopSession(deps.db, deps.spine, {
      tenantId: charter.tenantId,
      principalId: charter.principalId,
      reason,
    });
    resident.sessionId = session.id;
    let cost: Cost = ZERO_COST;
    let worked = 0;
    let stoppedFor: string | undefined;

    const p: PrincipalContext = {
      tenantId: charter.tenantId,
      principalId: charter.principalId,
      kind: "agent",
    };
    for (;;) {
      const spentToday = await sumRunUsdSince(
        deps.db,
        charter.tenantId,
        charter.principalId,
        startOfUtcDay(new Date()),
      );
      if (spentToday >= charter.budgets.usdPerDay) {
        stoppedFor = `daily budget exhausted ($${spentToday.toFixed(4)} of $${charter.budgets.usdPerDay})`;
        break;
      }
      const lease = await deps.workQueue.claim(p, {});
      if (lease === null) break;
      cost = addCost(cost, await runOne(resident, session.id, lease));
      worked++;
    }

    const nextWakeAt =
      charter.wake.heartbeat !== undefined
        ? nextCronWake(charter.wake.heartbeat, new Date())
        : undefined;
    await closeLoopSession(deps.db, deps.spine, session, {
      cost,
      summary:
        stoppedFor !== undefined
          ? `worked ${worked} item(s); stopped: ${stoppedFor}`
          : `worked ${worked} item(s); queue drained`,
      ...(nextWakeAt !== undefined ? { nextWakeAt } : {}),
    });
    delete resident.sessionId;
    resident.status =
      nextWakeAt !== undefined ? { state: "sleeping", until: nextWakeAt } : { state: "idle" };
  }

  async function wake(principalId: Ulid, reason: WakeReason): Promise<void> {
    const resident = residents.get(principalId);
    if (resident === undefined) {
      throw new Error(`agent ${principalId} is not resident — call ensure() first`);
    }
    if (resident.loopInFlight !== undefined) {
      resident.pendingWake = reason; // coalesce: one queued re-run, never parallel loops
      await resident.loopInFlight;
      return;
    }
    resident.status = { state: "running" };
    resident.loopInFlight = (async () => {
      let next: WakeReason | undefined = reason;
      while (next !== undefined) {
        await loopOnce(resident, next);
        next = resident.pendingWake;
        delete resident.pendingWake;
        if (next !== undefined) resident.status = { state: "running" };
      }
    })();
    try {
      await resident.loopInFlight;
    } finally {
      delete resident.loopInFlight;
    }
  }

  const host: AgentHost = {
    async ensure(principalId: Ulid): Promise<AgentHandle> {
      const existing = residents.get(principalId);
      if (existing !== undefined) {
        return {
          principalId,
          status: existing.status,
          ...(existing.sessionId !== undefined ? { sessionId: existing.sessionId } : {}),
        };
      }
      const charter = await deps.identity.getCharter(principalId);
      if (charter === null) {
        throw new Error(`principal ${principalId} has no agent charter — not a resident agent`);
      }
      const resident: Resident = { charter, status: { state: "idle" } };
      if (charter.wake.onEvents !== undefined && charter.wake.onEvents.length > 0) {
        resident.subscription = deps.spine.subscribe(
          `agents.host.${principalId}`,
          { topics: charter.wake.onEvents },
          async (event) => {
            // Never wake on the agent's own actions — that livelocks the loop.
            if (event.actor.kind === "principal" && event.actor.id === principalId) return;
            await wake(principalId, "event");
          },
        );
      }
      residents.set(principalId, resident);
      return { principalId, status: resident.status };
    },
    wake,
    async status(principalId: Ulid): Promise<AgentStatus> {
      return residents.get(principalId)?.status ?? { state: "stopped" };
    },
  };

  const heartbeatTickSource: TickSource = {
    id: "agents.heartbeat",
    async tick(now: Date): Promise<void> {
      const minute = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}T${now.getUTCHours()}:${now.getUTCMinutes()}`;
      for (const [principalId, resident] of residents) {
        const cron = resident.charter.wake.heartbeat;
        if (cron === undefined) continue;
        if (resident.lastHeartbeatMinute === minute) continue; // once per minute per agent
        if (!cronMatches(cron, now)) continue;
        resident.lastHeartbeatMinute = minute;
        await wake(principalId, "heartbeat");
      }
    },
  };

  return { host, heartbeatTickSource };
}
