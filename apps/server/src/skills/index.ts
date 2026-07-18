import type { GitRef, PrincipalContext, Ref, Skill, Ulid } from "@lithis/core";
import type { SkillCompleteFn } from "@lithis/sdk/skills";
import { stub } from "@lithis/stubkit";
import type { Db } from "../db";
import type { EventSpine, TickSource } from "../spine";
import type { ServerConfig } from "../config";
import type { HumanGate } from "../humangate";
import type { WorkQueue } from "../work";
import type { ConnectionRegistry } from "../connections";
import type { Delivery } from "../delivery";
import { createAnthropicComplete, DEFAULT_AGENT_MODEL } from "../agents";
import { createPgSkillRegistry } from "./service";
import {
  createSkillInvoker,
  createSkillScheduleTickSource,
  createSkillToolExecutor,
  listActiveSkills,
} from "./invoker";
import type { SkillInvoker } from "./invoker";
import type { SkillRuntime } from "./runtime";

/**
 * skills — git-authoritative definitions with the guarded self-modification
 * lifecycle: propose → evals → PR → approval → activate. REAL as of
 * P10-skills: the Postgres registry (service.ts, manifest-checksum-bound
 * activation), the in-process registration runtime (runtime.ts — main.ts
 * registers extension packages at boot, no dynamic code loading), and the
 * invoker (invoker.ts — durable skill_runs rows, the "skills.schedule" clock
 * TickSource, and the agent-facing tool executor).
 */

export interface SkillVersionDraft {
  tenantId: Ulid;
  slug: string;
  kind: Skill["kind"];
  semver: string;
  sourceRef: GitRef;
  manifest: unknown;
  authoredBy: Ref;
}

export interface ProposeResult {
  skillId: Ulid;
  versionId: Ulid;
  approvalRequestId: Ulid;
}

export interface SkillRunRecord {
  id: Ulid;
  tenantId: Ulid;
  skillId: Ulid;
  versionId: Ulid;
  trigger: "schedule" | "tool" | "manual";
  input: Record<string, unknown>;
  status: "running" | "succeeded" | "failed";
  result?: unknown;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface SkillRegistry {
  /** Computes capabilityDiff + checksum, gates via HumanRequest{skill_change}. Evals: see the evalgate stub. */
  propose(draft: SkillVersionDraft): Promise<ProposeResult>;
  /** Only after approval; checksum-bound to the registered runtime manifest. */
  activate(versionId: Ulid, tenantId: Ulid): Promise<void>;
  /** The skills this principal may invoke (charter-scoped; grant intersection deferred, ADR-006). */
  forPrincipal(p: PrincipalContext): Promise<Skill[]>;
  list(tenantId: Ulid): Promise<Skill[]>;
  runsFor(tenantId: Ulid, slug: string): Promise<SkillRunRecord[]>;
}

/** The agents executor's skill-tool seam (charter-scoped via the active-skill check). */
export interface SkillToolExecutor {
  /** undefined = not a skill tool (the dispatcher falls through to its unknown-tool error). */
  tryExecuteTool(
    p: PrincipalContext,
    toolName: string,
    input: unknown,
  ): Promise<{ result: string; isError: boolean } | undefined>;
}

/**
 * The eval gate (propose must run the version's eval suite before it is
 * approvable) is NOT implemented — P16-evals is pending. Registered so the
 * census shows the gap (the server.agents.host.memory precedent); nothing
 * calls it, and every skill_change approval payload carries
 * `evals: "not_run (P16-evals pending)"` so approvers see it too.
 */
export const runEvalGate = stub<(versionId: Ulid) => Promise<Ulid>>(
  "server.skills.registry.evalgate",
  "LITHIS-STUB: skill eval gate not implemented (P16-evals pending) — propose() records evals as not_run in the approval payload",
);

export interface SkillsRuntimeDeps {
  db: Db;
  spine: EventSpine;
  runtime: SkillRuntime;
  humanGate: HumanGate;
  workQueue: WorkQueue;
  connections?: Pick<ConnectionRegistry, "list">;
  delivery?: Pick<Delivery, "route">;
  config: Pick<ServerConfig, "anthropicApiKey" | "agentModel" | "slackDeliveryChannel">;
  /** Injectable LLM seam for tests; production derives it from ANTHROPIC_API_KEY. */
  complete?: SkillCompleteFn;
}

export interface SkillsService {
  registry: SkillRegistry;
  invoker: SkillInvoker;
  toolExecutor: SkillToolExecutor;
  /** Register with the clock: fires manifest.triggers.schedule crons. */
  scheduleTickSource: TickSource;
}

/** One-pass prompt→text completion over the agents module's Anthropic seam. */
function completeFromConfig(
  config: SkillsRuntimeDeps["config"],
): SkillCompleteFn | undefined {
  if (config.anthropicApiKey === undefined) return undefined;
  const anthropic = createAnthropicComplete(config.anthropicApiKey);
  const model = config.agentModel ?? DEFAULT_AGENT_MODEL;
  return async (prompt: string): Promise<string> => {
    const turn = await anthropic(
      {
        model,
        system: "You polish operational messages. Reply with the message text only.",
        maxTokens: 1024,
        messages: [{ role: "user", content: prompt }],
        tools: [],
      },
      new AbortController().signal,
    );
    return turn.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter((t) => t.length > 0)
      .join("\n");
  };
}

/** Wire the full skills runtime over shared deps (main.ts and integration tests). */
export function createSkillsService(deps: SkillsRuntimeDeps): SkillsService {
  const registry = createPgSkillRegistry({
    db: deps.db,
    spine: deps.spine,
    humanGate: deps.humanGate,
    runtime: deps.runtime,
  });
  const complete = deps.complete ?? completeFromConfig(deps.config);
  const invoker = createSkillInvoker({
    db: deps.db,
    spine: deps.spine,
    runtime: deps.runtime,
    humanGate: deps.humanGate,
    workQueue: deps.workQueue,
    ...(deps.connections !== undefined ? { connections: deps.connections } : {}),
    ...(deps.delivery !== undefined ? { delivery: deps.delivery } : {}),
    ...(deps.config.slackDeliveryChannel !== undefined
      ? { slackChannel: deps.config.slackDeliveryChannel }
      : {}),
    ...(complete !== undefined ? { complete } : {}),
  });
  return {
    registry,
    invoker,
    toolExecutor: createSkillToolExecutor({ db: deps.db, runtime: deps.runtime, invoker }),
    scheduleTickSource: createSkillScheduleTickSource({
      listActive: listActiveSkills(deps.db),
      invoker,
    }),
  };
}

/**
 * DB-less skeleton mode (DATABASE_URL unset): the registry cannot run.
 * Honest CONFIG degrade, not a stub — the real implementation exists and is
 * wired whenever a database is configured.
 */
export function createUnconfiguredSkillRegistry(): SkillRegistry {
  const fail = (): never => {
    throw new Error(
      "skill registry unavailable: DATABASE_URL is not set — the server is running in DB-less skeleton mode",
    );
  };
  return { propose: fail, activate: fail, forPrincipal: fail, list: fail, runsFor: fail };
}

export { createSkillRuntime } from "./runtime";
export type { SkillRegistration, SkillRuntime } from "./runtime";
export {
  SkillChecksumMismatchError,
  SkillNotApprovedError,
  canonicalJson,
  manifestChecksum,
} from "./service";
export {
  createSkillInvoker,
  createSkillScheduleTickSource,
  createSkillToolExecutor,
  listActiveSkills,
  minuteKey,
} from "./invoker";
export type { ActiveSkillRef, SkillInvoker, SkillTrigger } from "./invoker";
export { DEV_SEED_SKILL_SLUGS, ensureDevSkillsSeed } from "./seed";
