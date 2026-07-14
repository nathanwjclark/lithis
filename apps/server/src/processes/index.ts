import type {
  CascadePlan,
  Event,
  InvalidationCause,
  NodeDef,
  ProcessRun,
  Ref,
  Ulid,
} from "@lithis/core";
import { stubService } from "@lithis/stubkit";
import type { HumanRequestId } from "../humangate";

/**
 * processes — authored templates instantiated into runs whose nodes ARE
 * WorkItems (kind: process_node); WatchRules are bound per-instance at
 * instantiate() so new information matches THIS case's entities/doc types.
 *
 * THE INVALIDATOR NOTE: invalidation is ONE mechanism with three cause
 * sources — human deny/modify, deterministic WatchRule match, and Interpreter
 * judgment (one LLM run asserting "doc D affects node N" as an auditable
 * event; below the confidence bar it becomes a HumanRequest{question}, never
 * a silent rerun). The Invalidator is PURE CODE and the ONLY writer of
 * 'stale': planInvalidation is a dry-run always (over-threshold widths gate
 * as HumanRequest{cascade_plan}); executeInvalidation supersedes results,
 * stales dependents, flips granted HumanRequests to superseded, and revokes
 * in-flight leases. RunResult.inputsHash is a rerun SHORT-CIRCUIT
 * (equal hash ⇒ "no change" evidence), never an invalidation authority.
 */

export interface TemplateRef {
  id: Ulid;
  version: string;
}

/** A fully dynamic run: no template — the orchestrating agent mints the graph. */
export interface DynamicSpec {
  mode: "dynamic";
  goal: string;
  initialNodes?: NodeDef[];
}

/** Instance-graph change proposed by an agent (adaptive/dynamic modes). */
export interface GraphDelta {
  addNodes?: NodeDef[];
  addEdges?: { from: string; to: string }[];
  skipNodes?: string[];
  why: string;
}

export interface ProcessEngine {
  /** Mints WorkItems (kind process_node) + WorkEdges, binds WatchRules to the instance. */
  instantiate(
    t: TemplateRef | DynamicSpec,
    subject: Ref,
    bindings: Record<string, Ref>,
  ): Promise<ProcessRun>;
  /** Bound WatchRule matching; interpret-mode → LLM assertion → cause event. */
  onEvent(e: Event): Promise<InvalidationCause[]>;
  /** Pure, dry-run always — the only path to a CascadePlan. */
  planInvalidation(c: InvalidationCause): Promise<CascadePlan>;
  /** Supersede results, stale dependents, supersede granted gates, revoke leases. */
  executeInvalidation(p: CascadePlan): Promise<void>;
  /** Adaptive/dynamic graph changes gate through the ONE human primitive. */
  proposeGraphChange(runId: Ulid, delta: GraphDelta): Promise<HumanRequestId>;
}

const processEngine = stubService<ProcessEngine>(
  "server.processes.engine",
  ["instantiate", "onEvent", "planInvalidation", "executeInvalidation", "proposeGraphChange"],
  "LITHIS-STUB: process instantiation, WatchRule matching, and the Invalidator cascade not implemented",
);

export function createProcessEngine(): ProcessEngine {
  return processEngine;
}
