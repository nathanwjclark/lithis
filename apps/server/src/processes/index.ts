import type {
  CascadePlan,
  Event,
  InvalidationCause,
  NodeDef,
  PrincipalContext,
  ProcessRun,
  ProcessTemplate,
  Ref,
  Ulid,
} from "@lithis/core";
import type { Db } from "../db";
import type { HumanGate, HumanRequestId } from "../humangate";
import type { EventSpine, Subscription } from "../spine";
import type { WorkQueue } from "../work";
import { PROCESS_ENGINE_TOPICS, createPgProcessEngine } from "./service";

/**
 * processes — authored templates instantiated into runs whose nodes ARE
 * WorkItems (kind: process_node) opened through the real work queue with
 * depends_on edges; WatchRules are bound per-instance at instantiate() so new
 * information matches THIS case's entities/doc types. REAL as of phase P8 —
 * see service.ts (engine) and invalidator.ts (pure planning/matching logic).
 *
 * THE INVALIDATOR NOTE: invalidation is ONE mechanism with three cause
 * sources — human deny/modify, deterministic WatchRule match, and Interpreter
 * judgment (one LLM run asserting "doc D affects node N" as an auditable
 * event — still stubbed, P7 territory). The Invalidator is PURE CODE and the
 * ONLY writer of 'stale': planInvalidation is a dry-run always (over-threshold
 * widths park in processes.pending_actions behind a HumanRequest{cascade_plan});
 * executeInvalidation supersedes results (via the RunResultPort seam — the
 * real store lands with P7-agents), stales dependents, flips granted
 * HumanRequests to superseded, and revokes in-flight leases. RunResult
 * .inputsHash is a rerun SHORT-CIRCUIT (equal hash ⇒ "no change" evidence),
 * never an invalidation authority — it rides the P7 executor, not this module.
 */

export interface TemplateRef {
  id: Ulid;
  version: string;
}

/** A template before the engine assigns server fields. */
export type NewProcessTemplate = Omit<ProcessTemplate, "id" | "createdAt" | "updatedAt">;

/** A fully dynamic run: no template — the orchestrating agent mints the graph. */
export interface DynamicSpec {
  mode: "dynamic";
  goal: string;
  initialNodes?: NodeDef[];
}

/** Instance-graph change proposed by an agent (adaptive/dynamic modes). */
export interface GraphDelta {
  addNodes?: NodeDef[];
  /** `{from,to}` = "from depends_on to"; `from` must be a newly added node. */
  addEdges?: { from: string; to: string }[];
  skipNodes?: string[];
  why: string;
}

export interface InstantiateOptions {
  /** The caller: tenant scope + the principal who owns the node WorkItems. */
  owner: PrincipalContext;
  /** Instance bindings (name → Ref); entity refs scope the run's WatchRules. */
  bindings?: Record<string, Ref>;
}

/**
 * RunResult supersession seam. agents.run_results belongs to the agents
 * module (P7-agents, in flight) — the Invalidator flips results through this
 * port instead of reaching across module tables. Until P7 wires the real
 * store, the default port is a LOUD stub.
 */
export interface RunResultPort {
  /** Mark every live RunResult of the work item superseded; returns how many. */
  supersede(tenantId: Ulid, workItemId: Ulid, causeEventId?: Ulid): Promise<number>;
}

export interface ProcessEngineDeps {
  db: Db;
  spine: EventSpine;
  work: WorkQueue;
  gate: HumanGate;
  /** Defaults to the loud stub port (see RunResultPort). */
  results?: RunResultPort;
  /** Cascade plans wider than this gate as HumanRequest{cascade_plan} (default 3). */
  autoExecuteMaxWidth?: number;
}

export interface ProcessEngine {
  /** Store an authored template version; emits process.template.saved. */
  saveTemplate(t: NewProcessTemplate): Promise<ProcessTemplate>;
  getRun(id: Ulid): Promise<ProcessRun | undefined>;
  /** Mints WorkItems (kind process_node) + WorkEdges, binds WatchRules to the instance. */
  instantiate(t: TemplateRef | DynamicSpec, subject: Ref, opts: InstantiateOptions): Promise<ProcessRun>;
  /** Bound WatchRule matching + deny/modify resolutions → causes (no side effects). */
  onEvent(e: Event): Promise<InvalidationCause[]>;
  /** The full pipeline: settle parked plans/gates, then plan + execute/park each cause. */
  handleEvent(e: Event): Promise<void>;
  /** Pure, dry-run always — the only path to a CascadePlan. */
  planInvalidation(c: InvalidationCause): Promise<CascadePlan>;
  /** Supersede results, stale dependents, supersede granted gates, revoke leases. */
  executeInvalidation(p: CascadePlan): Promise<void>;
  /** Adaptive/dynamic graph changes gate through the ONE human primitive. */
  proposeGraphChange(runId: Ulid, delta: GraphDelta, by: PrincipalContext): Promise<HumanRequestId>;
}

export function createProcessEngine(deps: ProcessEngineDeps): ProcessEngine {
  return createPgProcessEngine(deps);
}

/**
 * The engine's durable spine subscription (orchestrator role): doc arrivals
 * and gate resolutions flow into handleEvent, at-least-once with a
 * checkpointed cursor.
 */
export function subscribeProcessEngine(spine: EventSpine, engine: ProcessEngine): Subscription {
  return spine.subscribe(
    "processes.engine",
    { topics: [...PROCESS_ENGINE_TOPICS] },
    (e) => engine.handleEvent(e),
  );
}

/**
 * DB-less skeleton mode (DATABASE_URL unset): honest CONFIG degrade, not a
 * stub — the real engine exists and is wired whenever a database is
 * configured (see main.ts).
 */
export function createUnconfiguredProcessEngine(): ProcessEngine {
  const fail = (): never => {
    throw new Error(
      "process engine unavailable: DATABASE_URL is not set — the server is running in DB-less skeleton mode",
    );
  };
  return {
    saveTemplate: fail,
    getRun: fail,
    instantiate: fail,
    onEvent: fail,
    handleEvent: fail,
    planInvalidation: fail,
    executeInvalidation: fail,
    proposeGraphChange: fail,
  };
}

export { PROCESS_ENGINE_TOPICS, stubInterpretAssertion, stubRunResultPort } from "./service";
export {
  GraphChangeRejectedError,
  ProcessNodeNotFoundError,
  ProcessRunNotFoundError,
  ProcessTemplateNotFoundError,
} from "./service";
export type { BoundRule, KeyEdge } from "./invalidator";
export {
  ProcessGraphCycleError,
  UnknownNodeKeyError,
  bindWatchRules,
  matchesWatchRule,
  topoOrder,
  walkDependents,
} from "./invalidator";
