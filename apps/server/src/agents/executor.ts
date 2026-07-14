import Anthropic from "@anthropic-ai/sdk";
import { NotImplementedError, stub } from "@lithis/stubkit";
import type { Cost, PrincipalContext, RunBrief } from "@lithis/core";
import type { Db } from "../db";
import type { EventSpine } from "../spine";
import type { WorkQueue } from "../work";
import { ADD_WORK_NOTE_TOOL, RECORD_RESULT_TOOL, REPORT_BLOCKER_TOOL } from "./toolbroker";
import { ZERO_COST, addCost, sha256Hex } from "./store";
import type { TranscriptStore } from "./store";
import type { AgentExecutor, AgentRunOutcome, ToolBroker, ToolSet } from "./index";

/**
 * The AgentExecutor — one run is one Anthropic tool-use loop. This file owns
 * ALL LLM plumbing: the injectable complete() seam (tests script it; the real
 * one is the @anthropic-ai/sdk Messages call), the system prompt, the tool
 * dispatch, per-call cost metering, and the budget/abort discipline:
 *
 * - the AbortSignal is load-bearing — lease revocation aborts the in-flight
 *   model call and the loop (status `cancelled`);
 * - the usd budget is checked after EVERY model call — a run that crosses it
 *   is aborted mid-run (status `cancelled`, blocker names the overrun);
 * - the run ends when the agent calls record_result (done) or report_blocker
 *   (blocked); an agent that just stops talking gets one nudge, then fails.
 *
 * The transcript (system + every turn + tool results) is stored durably as a
 * context blob; its id rides RunOutcome.transcriptRef.
 */

export const DEFAULT_AGENT_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_TURNS = 24;

// ── the LLM seam ────────────────────────────────────────────────────────────

export interface CompleteRequest {
  model: string;
  system: string;
  maxTokens: number;
  messages: Anthropic.Messages.MessageParam[];
  tools: Anthropic.Messages.Tool[];
}

/** What one model call produced — the only shape tests have to fake. */
export interface ModelTurn {
  content: Anthropic.Messages.ContentBlock[];
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

export type CompleteFn = (req: CompleteRequest, signal: AbortSignal) => Promise<ModelTurn>;

/**
 * The real seam: @anthropic-ai/sdk Messages API (the ONE allowed dependency).
 * The key lives only inside the SDK client — never logged, never persisted.
 */
export function createAnthropicComplete(apiKey: string): CompleteFn {
  const client = new Anthropic({ apiKey });
  return async (req, signal) => {
    const res = await client.messages.create(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: req.messages,
        tools: req.tools,
      },
      { signal },
    );
    return {
      content: res.content,
      stopReason: res.stop_reason,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    };
  };
}

// ── cost metering ───────────────────────────────────────────────────────────

export interface ModelPricing {
  /** USD per million input tokens. */
  inPerMTok: number;
  /** USD per million output tokens. */
  outPerMTok: number;
}

/** Sticker prices (2026-06); unknown models meter at a conservative Opus-plus rate. */
const PRICING: Record<string, ModelPricing> = {
  "claude-sonnet-5": { inPerMTok: 3, outPerMTok: 15 },
  "claude-sonnet-4-6": { inPerMTok: 3, outPerMTok: 15 },
  "claude-opus-4-8": { inPerMTok: 5, outPerMTok: 25 },
  "claude-haiku-4-5": { inPerMTok: 1, outPerMTok: 5 },
};
const FALLBACK_PRICING: ModelPricing = { inPerMTok: 15, outPerMTok: 75 };

export function costOfTurn(model: string, usage: ModelTurn["usage"], pricing?: ModelPricing): Cost {
  const p = pricing ?? PRICING[model] ?? FALLBACK_PRICING;
  return {
    tokensIn: usage.inputTokens,
    tokensOut: usage.outputTokens,
    usd: (usage.inputTokens * p.inPerMTok + usage.outputTokens * p.outPerMTok) / 1_000_000,
  };
}

// ── the system prompt ───────────────────────────────────────────────────────

const EXECUTOR_SYSTEM = `You are a lithis resident agent working one work item.

The brief below is your full context. Work the item using your tools, then you MUST finish with exactly one of:
- record_result — the work is done; give a clear summary (and structured resultJson when a result schema was provided);
- report_blocker — something outside your control blocks the work; say what and who/what could unblock it.

Use add_work_note for durable progress notes worth a human reading later. Do not fabricate results: if you cannot actually complete the work with the tools available, report a blocker instead.`;

// ── skill tools (issued by the broker, not yet executable) ──────────────────

/**
 * Skill-manifest tools are on the surface (toolbroker.ts) but executing them
 * lands with P10-skills. Calls fail loudly through this stub; the model sees
 * the stub reason as an is_error tool result and can report a blocker.
 */
const executeSkillTool = stub<(tool: string, input: unknown) => Promise<string>>(
  "server.agents.executor.skilltool",
  "LITHIS-STUB: skill-manifest tool execution not implemented (P10-skills); base tools only",
);

// ── the executor ────────────────────────────────────────────────────────────

export interface RunExecutorDeps {
  db: Db;
  spine: EventSpine;
  complete: CompleteFn;
  toolBroker: ToolBroker;
  workQueue: WorkQueue;
  transcripts: TranscriptStore;
  model: string;
  maxTokens?: number;
  maxTurns?: number;
  pricing?: ModelPricing;
}

interface TerminalCall {
  status: "done" | "blocked";
  summary?: string;
  resultJson?: unknown;
  blocker?: string;
}

function toAnthropicTools(toolset: ToolSet): Anthropic.Messages.Tool[] {
  return toolset.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
  }));
}

export function inputsHashFor(brief: RunBrief): string {
  const tuples = [
    ...(brief.workItemId !== undefined
      ? [["work_item", brief.workItemId, sha256Hex(brief.contextSlice)]]
      : [["brief", "-", sha256Hex(brief.contextSlice)]]),
  ].sort();
  return sha256Hex(JSON.stringify(tuples));
}

export function createRunExecutor(deps: RunExecutorDeps): AgentExecutor {
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;

  async function emitToolCalled(brief: RunBrief, tool: string, isError: boolean): Promise<void> {
    // Sole purpose of this tx is the audit event itself (the broker contract:
    // every tool call is a spine event); append still requires an outbox tx.
    await deps.db.withTx(async (tx) => {
      await deps.spine.append(tx, {
        tenantId: brief.tenantId,
        topic: "agent.tool_called",
        subjectRefs: [
          { kind: "principal", id: brief.principalId },
          ...(brief.workItemId !== undefined
            ? [{ kind: "work_item", id: brief.workItemId } as const]
            : []),
        ],
        actor: { kind: "principal", id: brief.principalId },
        payload: { tool, isError },
      });
    });
  }

  async function dispatchTool(
    brief: RunBrief,
    name: string,
    input: unknown,
  ): Promise<{ result: string; isError: boolean; terminal?: TerminalCall }> {
    const args = (input ?? {}) as Record<string, unknown>;
    switch (name) {
      case RECORD_RESULT_TOOL: {
        const summary = typeof args["summary"] === "string" ? (args["summary"] as string) : "";
        if (summary.length === 0) {
          return { result: "record_result requires a non-empty summary", isError: true };
        }
        return {
          result: "result recorded",
          isError: false,
          terminal: { status: "done", summary, resultJson: args["resultJson"] },
        };
      }
      case REPORT_BLOCKER_TOOL: {
        const blocker = typeof args["blocker"] === "string" ? (args["blocker"] as string) : "";
        if (blocker.length === 0) {
          return { result: "report_blocker requires a non-empty blocker", isError: true };
        }
        return { result: "blocker recorded", isError: false, terminal: { status: "blocked", blocker } };
      }
      case ADD_WORK_NOTE_TOOL: {
        const text = typeof args["text"] === "string" ? (args["text"] as string) : "";
        if (text.length === 0 || brief.workItemId === undefined) {
          return { result: "add_work_note requires text and a work item", isError: true };
        }
        await deps.workQueue.addNote(brief.workItemId, {
          byRef: { kind: "principal", id: brief.principalId },
          kind: "system",
          text,
        });
        return { result: "note added", isError: false };
      }
      default: {
        try {
          return { result: await executeSkillTool(name, input), isError: false };
        } catch (err) {
          if (err instanceof NotImplementedError) {
            return { result: `tool '${name}' is not executable: ${err.reason}`, isError: true };
          }
          throw err;
        }
      }
    }
  }

  return {
    async execute(brief: RunBrief, signal: AbortSignal): Promise<AgentRunOutcome> {
      const p: PrincipalContext = {
        tenantId: brief.tenantId,
        principalId: brief.principalId,
        kind: "agent",
      };
      const tools = toAnthropicTools(deps.toolBroker.toolsFor(p));
      const startedMs = Date.now();
      let cost: Cost = ZERO_COST;
      let nudged = false;

      const userText =
        brief.contextSlice +
        (brief.reworkInput !== undefined
          ? `\n\n## Rework requested\nReviewer comment: ${brief.reworkInput.comment}` +
            (brief.reworkInput.modification !== undefined
              ? `\nModification: ${JSON.stringify(brief.reworkInput.modification)}`
              : "")
          : "") +
        (brief.resultSchemaRef !== undefined
          ? `\n\n## Result schema\nresultJson must match schema ref: ${brief.resultSchemaRef}`
          : "");
      const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: userText }];

      const finish = async (
        partial: Pick<AgentRunOutcome, "status" | "blocker" | "resultJson"> & { summary?: string },
      ): Promise<AgentRunOutcome> => {
        const transcriptBlobId = await deps.transcripts.put({
          tenantId: brief.tenantId,
          principalId: brief.principalId,
          transcript: {
            system: EXECUTOR_SYSTEM,
            model: deps.model,
            messages,
            status: partial.status,
            ...(partial.blocker !== undefined ? { blocker: partial.blocker } : {}),
            cost,
          },
        });
        return {
          status: partial.status,
          ...(partial.resultJson !== undefined ? { resultJson: partial.resultJson } : {}),
          ...(partial.summary !== undefined ? { summary: partial.summary } : {}),
          ...(partial.blocker !== undefined ? { blocker: partial.blocker } : {}),
          evidenceDrafts: [],
          newTasks: [],
          cost,
          transcriptRef: transcriptBlobId,
        };
      };

      for (let turn = 0; turn < maxTurns; turn++) {
        if (signal.aborted) {
          return finish({ status: "cancelled", blocker: "aborted: lease revoked or host shutdown" });
        }
        if (Date.now() - startedMs > brief.budget.maxMinutes * 60_000) {
          return finish({
            status: "cancelled",
            blocker: `time budget exceeded (${brief.budget.maxMinutes} minutes)`,
          });
        }

        let modelTurn: ModelTurn;
        try {
          modelTurn = await deps.complete(
            { model: deps.model, system: EXECUTOR_SYSTEM, maxTokens, messages, tools },
            signal,
          );
        } catch (err) {
          if (signal.aborted) {
            return finish({ status: "cancelled", blocker: "aborted: lease revoked or host shutdown" });
          }
          return finish({
            status: "failed",
            blocker: `model call failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }

        cost = addCost(cost, costOfTurn(deps.model, modelTurn.usage, deps.pricing));
        messages.push({ role: "assistant", content: modelTurn.content });

        // Budget abort mid-run: the check runs after EVERY metered call.
        if (cost.usd > brief.budget.usd) {
          return finish({
            status: "cancelled",
            blocker: `usd budget exceeded ($${cost.usd.toFixed(4)} of $${brief.budget.usd.toFixed(4)})`,
          });
        }

        const toolUses = modelTurn.content.filter(
          (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
        );

        if (toolUses.length === 0) {
          if (nudged) {
            return finish({
              status: "failed",
              blocker: "agent ended its turn twice without record_result/report_blocker",
            });
          }
          nudged = true;
          messages.push({
            role: "user",
            content:
              "You must finish by calling record_result (work done) or report_blocker (work blocked).",
          });
          continue;
        }

        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
        let terminal: TerminalCall | undefined;
        for (const call of toolUses) {
          if (signal.aborted) break;
          const { result, isError, terminal: t } = await dispatchTool(brief, call.name, call.input);
          await emitToolCalled(brief, call.name, isError);
          toolResults.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: result,
            is_error: isError,
          });
          if (t !== undefined) {
            terminal = t;
            break; // record_result/report_blocker end the run — nothing after them executes
          }
        }
        messages.push({ role: "user", content: toolResults });

        if (terminal !== undefined) {
          return finish(
            terminal.status === "done"
              ? { status: "done", resultJson: terminal.resultJson, summary: terminal.summary! }
              : { status: "blocked", blocker: terminal.blocker! },
          );
        }
      }

      return finish({ status: "failed", blocker: `run exceeded ${maxTurns} model turns` });
    },
  };
}
