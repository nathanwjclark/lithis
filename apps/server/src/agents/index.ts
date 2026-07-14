import type { IsoDateTime, PrincipalContext, RunBrief, RunOutcome, SkillManifest, Ulid } from "@lithis/core";
import { stubService } from "@lithis/stubkit";

/**
 * agents — resident, openclaw-style agents: long-lived daemons with durable
 * memory, woken by heartbeat/message/event/work_available/manual. The loop
 * inside an agent: wake → open Session → read charter + own memory + inbox +
 * claimable work → act (runs, tool calls, outbound comms, WorkNotes) → set
 * own next wake → close Session. The agent decides what to do; the host only
 * delivers wake reasons and enforces budgets/heartbeats.
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

/** One agent execution (Claude Agent SDK inside); aborted via lease revocation → AbortSignal. */
export interface AgentExecutor {
  execute(brief: RunBrief, signal: AbortSignal): Promise<RunOutcome>;
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
 * (grant intersection deferred with the policy layer); network_only
 * capabilities are pre-filtered here; every tool call emits a spine event.
 */
export interface ToolBroker {
  toolsFor(p: PrincipalContext, manifest?: SkillManifest): ToolSet;
}

const agentHost = stubService<AgentHost>(
  "server.agents.host",
  ["ensure", "wake", "status"],
  "LITHIS-STUB: resident agent daemons (wake loop, sessions, budgets, heartbeats) not implemented",
);

const agentExecutor = stubService<AgentExecutor>(
  "server.agents.executor",
  ["execute"],
  "LITHIS-STUB: Claude Agent SDK executor (briefs, transcripts, cost metering, abort) not implemented",
);

const toolBroker = stubService<ToolBroker>(
  "server.agents.toolbroker",
  ["toolsFor"],
  "LITHIS-STUB: tool scoping from charter + skill manifests (the capability choke point) not implemented",
);

export function createAgentHost(): AgentHost {
  return agentHost;
}

export function createAgentExecutor(): AgentExecutor {
  return agentExecutor;
}

export function createToolBroker(): ToolBroker {
  return toolBroker;
}
