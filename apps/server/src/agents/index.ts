import type {
  IsoDateTime,
  PrincipalContext,
  RunBrief,
  RunOutcome,
  SkillManifest,
  Ulid,
} from "@lithis/core";
import { stub } from "@lithis/stubkit";
import type { Db } from "../db";
import type { EventSpine, TickSource } from "../spine";
import type { ServerConfig } from "../config";
import type { IdentityService } from "../iam";
import type { WorkQueue } from "../work";
import type { ContextStore } from "../context";
import { createAnthropicComplete, createRunExecutor, DEFAULT_AGENT_MODEL } from "./executor";
import type { CompleteFn } from "./executor";
import { createResidentAgentHost } from "./host";
import { createCharterToolBroker } from "./toolbroker";
import { transcriptStoreFromContext } from "./store";
import type { TranscriptStore } from "./store";

/**
 * agents — resident, openclaw-style agents: long-lived daemons with durable
 * memory, woken by heartbeat/message/event/work_available/manual. The loop
 * inside an agent: wake → open Session → read charter + claimable work → act
 * (runs, tool calls, WorkNotes) → set own next wake → close Session. The
 * agent decides what to do; the host only delivers wake reasons and enforces
 * budgets/heartbeats.
 *
 * REAL as of phase P7 — see host.ts (wake loop, sessions, daily budget),
 * executor.ts (the Anthropic tool-use loop, cost metering, budget abort),
 * toolbroker.ts (the tool surface), store.ts (runs/results/evidence rows +
 * transcript blobs).
 */

export type WakeReason = "heartbeat" | "message" | "event" | "work_available" | "manual";

export type AgentStatus =
  | { state: "running" | "idle" | "stopped" }
  | { state: "sleeping"; until: IsoDateTime };

export interface AgentHandle {
  principalId: Ulid;
  status: AgentStatus;
  /** The session the agent is currently in, when awake. */
  sessionId?: Ulid;
}

export interface AgentHost {
  /** Start/resume the resident daemon per its charter. */
  ensure(principalId: Ulid): Promise<AgentHandle>;
  wake(principalId: Ulid, reason: WakeReason): Promise<void>;
  status(principalId: Ulid): Promise<AgentStatus>;
}

/** The executor may carry a model-authored summary alongside the core RunOutcome. */
export interface AgentRunOutcome extends RunOutcome {
  summary?: string;
}

/** One agent execution (Anthropic tool-use loop inside); aborted via lease revocation → AbortSignal. */
export interface AgentExecutor {
  execute(brief: RunBrief, signal: AbortSignal): Promise<AgentRunOutcome>;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON schema for the tool's input. */
  inputSchema: Record<string, unknown>;
}

export interface ToolSet {
  tools: ToolDef[];
}

/**
 * THE scope choke point: charter + skill manifests decide the tool surface
 * (grant intersection deferred with the policy layer); every tool call emits
 * a spine event (agent.tool_called, appended by the executor per dispatch).
 */
export interface ToolBroker {
  toolsFor(p: PrincipalContext, manifest?: SkillManifest): ToolSet;
}

/**
 * The agent memory notebook (charter.memoryBlobId) — read at every wake,
 * appended by the agent — is NOT implemented: the ContextStore exposes no
 * blob-read surface yet, so briefs are assembled without it. Registered here
 * so the census shows the gap; nothing calls it.
 */
export const readAgentMemory = stub<(tenantId: Ulid, memoryBlobId: Ulid) => Promise<string>>(
  "server.agents.host.memory",
  "LITHIS-STUB: agent memory notebook read/append not implemented (ContextStore has no blob-read surface yet)",
);

export interface AgentsRuntimeDeps {
  db: Db;
  spine: EventSpine;
  identity: IdentityService;
  workQueue: WorkQueue;
  /** Transcript blobs land in the context store (blob dedupe + provenance). */
  contextStore: ContextStore;
  /** Injectable LLM seam — tests script it; production uses the Anthropic SDK. */
  complete?: CompleteFn;
  config: Pick<ServerConfig, "anthropicApiKey" | "agentModel">;
  /** Lease heartbeat cadence while a run is in flight (default 60s). */
  leaseHeartbeatMs?: number;
  /** Per-run wall-clock ceiling handed to briefs (default 15 minutes). */
  runMaxMinutes?: number;
}

export interface AgentsRuntime {
  host: AgentHost;
  executor: AgentExecutor;
  toolBroker: ToolBroker;
  /** Register with the clock: fires charter heartbeat crons. */
  heartbeatTickSource: TickSource;
}

/** Wire the full agents runtime over shared deps (main.ts and integration tests). */
export function createAgentsRuntime(deps: AgentsRuntimeDeps): AgentsRuntime {
  const model = deps.config.agentModel ?? DEFAULT_AGENT_MODEL;
  const complete =
    deps.complete ??
    (deps.config.anthropicApiKey !== undefined
      ? createAnthropicComplete(deps.config.anthropicApiKey)
      : failUnconfiguredComplete);
  const toolBroker = createCharterToolBroker();
  const transcripts: TranscriptStore = transcriptStoreFromContext(deps.contextStore);
  const executor = createRunExecutor({
    db: deps.db,
    spine: deps.spine,
    complete,
    toolBroker,
    workQueue: deps.workQueue,
    transcripts,
    model,
  });
  const { host, heartbeatTickSource } = createResidentAgentHost({
    db: deps.db,
    spine: deps.spine,
    identity: deps.identity,
    workQueue: deps.workQueue,
    executor,
    model,
    ...(deps.leaseHeartbeatMs !== undefined ? { leaseHeartbeatMs: deps.leaseHeartbeatMs } : {}),
    ...(deps.runMaxMinutes !== undefined ? { runMaxMinutes: deps.runMaxMinutes } : {}),
  });
  return { host, executor, toolBroker, heartbeatTickSource };
}

/**
 * Honest CONFIG degrade (the context-store precedent): when ANTHROPIC_API_KEY
 * is unset and no fake was injected, real agent runs cannot happen — the run
 * fails with a clear error naming the missing configuration. Not a stub: the
 * real implementation exists and is wired whenever a key (or seam) is present.
 */
const failUnconfiguredComplete: CompleteFn = () => {
  throw new Error(
    "agent executor unavailable: ANTHROPIC_API_KEY is not set and no complete() seam was injected",
  );
};

/** DB-less skeleton mode (DATABASE_URL unset): the agent host cannot run. */
export function createUnconfiguredAgentHost(): AgentHost {
  const fail = (): never => {
    throw new Error(
      "agent host unavailable: DATABASE_URL is not set — the server is running in DB-less skeleton mode",
    );
  };
  return { ensure: fail, wake: fail, status: fail };
}

/** DB-less skeleton mode (DATABASE_URL unset): the executor cannot run. */
export function createUnconfiguredAgentExecutor(): AgentExecutor {
  return {
    execute: () => {
      throw new Error(
        "agent executor unavailable: DATABASE_URL is not set — the server is running in DB-less skeleton mode",
      );
    },
  };
}

/** The ToolBroker is pure (no db) and always real. */
export function createToolBroker(): ToolBroker {
  return createCharterToolBroker();
}

export { DEFAULT_AGENT_MODEL, createAnthropicComplete } from "./executor";
export type { CompleteFn, ModelTurn, CompleteRequest } from "./executor";
export {
  RECORD_RESULT_TOOL,
  REPORT_BLOCKER_TOOL,
  ADD_WORK_NOTE_TOOL,
  skillToolName,
} from "./toolbroker";
