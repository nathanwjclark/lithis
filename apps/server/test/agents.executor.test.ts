import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { newUlid } from "@lithis/core";
import type { RunBrief } from "@lithis/core";
import { costOfTurn, createRunExecutor, inputsHashFor } from "../src/agents/executor";
import type { CompleteFn, ModelTurn } from "../src/agents/executor";
import { createCharterToolBroker, skillToolName } from "../src/agents/toolbroker";
import type { TranscriptStore } from "../src/agents/store";
import type { Db, DbTx } from "../src/db";
import type { EventSpine } from "../src/spine";
import type { WorkQueue } from "../src/work";

/**
 * Executor units — REAL code paths, fake LLM. The complete() seam is the one
 * place a test-injected fake model is correct: the loop, tool dispatch, cost
 * metering, budget abort, and abort-signal handling under test are all real.
 */

function text(t: string): Anthropic.Messages.ContentBlock {
  return { type: "text", text: t, citations: null } as Anthropic.Messages.TextBlock;
}

function toolUse(name: string, input: unknown): Anthropic.Messages.ContentBlock {
  return { type: "tool_use", id: `toolu_${newUlid()}`, name, input } as Anthropic.Messages.ToolUseBlock;
}

function turn(
  content: Anthropic.Messages.ContentBlock[],
  usage: ModelTurn["usage"] = { inputTokens: 1_000, outputTokens: 500 },
): ModelTurn {
  return { content, stopReason: "tool_use", usage };
}

interface Harness {
  execute: (brief?: Partial<RunBrief>, signal?: AbortSignal) => Promise<import("../src/agents").AgentRunOutcome>;
  events: { topic: string; payload: unknown }[];
  notes: { workItemId: string; text: string }[];
  transcripts: unknown[];
  calls: () => number;
}

function harness(turns: ModelTurn[], opts: { complete?: CompleteFn } = {}): Harness {
  const events: Harness["events"] = [];
  const notes: Harness["notes"] = [];
  const transcripts: unknown[] = [];
  let calls = 0;

  const db = {
    withTx: async <T>(fn: (tx: DbTx) => Promise<T>): Promise<T> => fn({ __brand: "DbTx" } as DbTx),
  } as unknown as Db;
  const spine = {
    append: async (_tx: DbTx, e: { topic: string; payload?: unknown }) => {
      events.push({ topic: e.topic, payload: e.payload });
      return e;
    },
  } as unknown as EventSpine;
  const workQueue = {
    addNote: async (workItemId: string, n: { text: string }) => {
      notes.push({ workItemId, text: n.text });
    },
  } as unknown as WorkQueue;
  const transcriptStore: TranscriptStore = {
    put: async (input) => {
      transcripts.push(input.transcript);
      return newUlid();
    },
  };
  const complete: CompleteFn =
    opts.complete ??
    (async () => {
      const next = turns[calls++];
      if (next === undefined) throw new Error("fake model script exhausted");
      return next;
    });

  const executor = createRunExecutor({
    db,
    spine,
    complete: async (req, signal) => {
      if (opts.complete !== undefined) calls++;
      return complete(req, signal);
    },
    toolBroker: createCharterToolBroker(),
    workQueue,
    transcripts: transcriptStore,
    model: "claude-sonnet-5",
  });

  const tenantId = newUlid();
  const principalId = newUlid();
  const workItemId = newUlid();
  return {
    execute: (brief = {}, signal = new AbortController().signal) =>
      executor.execute(
        {
          tenantId,
          principalId,
          workItemId,
          contextSlice: "## Work item\nDo the thing",
          budget: { usd: 1, maxMinutes: 5 },
          ...brief,
        },
        signal,
      ),
    events,
    notes,
    transcripts,
    calls: () => calls,
  };
}

describe("run executor", () => {
  test("happy path: note + record_result → done with summary, cost, transcript, tool events", async () => {
    const h = harness([
      turn([text("working"), toolUse("add_work_note", { text: "started" })]),
      turn([toolUse("record_result", { summary: "did the thing", resultJson: { ok: true } })]),
    ]);
    const outcome = await h.execute();

    expect(outcome.status).toBe("done");
    expect(outcome.summary).toBe("did the thing");
    expect(outcome.resultJson).toEqual({ ok: true });
    // Two sonnet-5 calls at 1000 in / 500 out each: 2 * (1000*3 + 500*15) / 1e6.
    expect(outcome.cost).toEqual({ tokensIn: 2_000, tokensOut: 1_000, usd: 0.021 });
    expect(outcome.transcriptRef).toBeDefined();
    expect(h.transcripts.length).toBe(1);
    expect(h.notes.map((n) => n.text)).toEqual(["started"]);
    expect(h.events.map((e) => e.topic)).toEqual(["agent.tool_called", "agent.tool_called"]);
    expect(h.events.map((e) => (e.payload as { tool: string }).tool)).toEqual([
      "add_work_note",
      "record_result",
    ]);
  });

  test("report_blocker → blocked with the blocker text", async () => {
    const h = harness([turn([toolUse("report_blocker", { blocker: "no credentials for CRM" })])]);
    const outcome = await h.execute();
    expect(outcome.status).toBe("blocked");
    expect(outcome.blocker).toBe("no credentials for CRM");
  });

  test("budget abort fires mid-run: over-budget model call cancels before any tool executes", async () => {
    // One call at 10M output tokens ≈ $150 >> the $0.05 budget.
    const h = harness([
      turn(
        [toolUse("record_result", { summary: "should never be recorded" })],
        { inputTokens: 1_000, outputTokens: 10_000_000 },
      ),
      turn([toolUse("record_result", { summary: "never reached" })]),
    ]);
    const outcome = await h.execute({ budget: { usd: 0.05, maxMinutes: 5 } });

    expect(outcome.status).toBe("cancelled");
    expect(outcome.blocker).toMatch(/usd budget exceeded/);
    expect(h.events.length).toBe(0); // the tool call after the overrun never dispatched
    expect(outcome.cost.usd).toBeGreaterThan(0.05);
  });

  test("pre-aborted signal → cancelled without calling the model", async () => {
    const h = harness([turn([toolUse("record_result", { summary: "no" })])]);
    const controller = new AbortController();
    controller.abort();
    const outcome = await h.execute({}, controller.signal);
    expect(outcome.status).toBe("cancelled");
    expect(outcome.blocker).toMatch(/aborted/);
    expect(h.calls()).toBe(0);
  });

  test("abort during the model call (lease revoked) → cancelled", async () => {
    const controller = new AbortController();
    const h = harness([], {
      complete: async (_req, signal) => {
        controller.abort();
        throw Object.assign(new Error("Request was aborted."), { aborted: signal.aborted });
      },
    });
    const outcome = await h.execute({}, controller.signal);
    expect(outcome.status).toBe("cancelled");
    expect(outcome.blocker).toMatch(/aborted/);
  });

  test("agent that stops talking gets one nudge, then the run fails", async () => {
    const h = harness([turn([text("all done I think")]), turn([text("bye")])]);
    const outcome = await h.execute();
    expect(outcome.status).toBe("failed");
    expect(outcome.blocker).toMatch(/without record_result/);
    expect(h.calls()).toBe(2);
  });

  test("unknown (skill) tool fails loudly through the stub but the run can recover", async () => {
    const h = harness([
      turn([toolUse("skill_quote_generator", { account: "acme" })]),
      turn([toolUse("report_blocker", { blocker: "skill tooling unavailable" })]),
    ]);
    const outcome = await h.execute();
    expect(outcome.status).toBe("blocked");
    const skillEvent = h.events[0]!.payload as { tool: string; isError: boolean };
    expect(skillEvent).toEqual({ tool: "skill_quote_generator", isError: true });
    // The model saw the loud stub reason as an is_error tool result.
    const transcript = JSON.stringify(h.transcripts[0]);
    expect(transcript).toContain("LITHIS-STUB");
  });

  test("model call failure (e.g. missing ANTHROPIC_API_KEY) → failed with a clear blocker", async () => {
    const h = harness([], {
      complete: () => {
        throw new Error("agent executor unavailable: ANTHROPIC_API_KEY is not set");
      },
    });
    const outcome = await h.execute();
    expect(outcome.status).toBe("failed");
    expect(outcome.blocker).toMatch(/ANTHROPIC_API_KEY/);
  });

  test("record_result without a summary is rejected as a tool error, not accepted silently", async () => {
    const h = harness([
      turn([toolUse("record_result", {})]),
      turn([toolUse("record_result", { summary: "ok this time" })]),
    ]);
    const outcome = await h.execute();
    expect(outcome.status).toBe("done");
    expect(outcome.summary).toBe("ok this time");
    expect((h.events[0]!.payload as { isError: boolean }).isError).toBe(true);
  });
});

describe("cost + hashing helpers", () => {
  test("costOfTurn prices sonnet-5 at sticker and falls back conservatively", () => {
    expect(costOfTurn("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 }).usd).toBe(18);
    expect(costOfTurn("who-knows-9", { inputTokens: 1_000_000, outputTokens: 0 }).usd).toBe(15);
  });

  test("inputsHashFor is deterministic and sensitive to the slice", () => {
    const brief: RunBrief = {
      tenantId: newUlid(),
      principalId: newUlid(),
      workItemId: newUlid(),
      contextSlice: "a",
      budget: { usd: 1, maxMinutes: 1 },
    };
    expect(inputsHashFor(brief)).toBe(inputsHashFor(brief));
    expect(inputsHashFor({ ...brief, contextSlice: "b" })).not.toBe(inputsHashFor(brief));
  });
});

describe("tool broker", () => {
  const p = { tenantId: newUlid(), principalId: newUlid(), kind: "agent" as const };

  test("base surface: record_result / report_blocker / add_work_note", () => {
    const { tools } = createCharterToolBroker().toolsFor(p);
    expect(tools.map((t) => t.name)).toEqual(["record_result", "report_blocker", "add_work_note"]);
    for (const tool of tools) {
      expect(tool.inputSchema["type"]).toBe("object");
    }
  });

  test("a skill manifest widens the surface by exactly one tool with its own schema", () => {
    const manifest = {
      description: "Generate a quote PDF",
      inputSchema: { type: "object", properties: { account: { type: "string" } } },
      capabilitiesRequired: ["crm.read"],
      selfModBounds: { modifiablePaths: [], forbidden: [] },
    };
    const { tools } = createCharterToolBroker().toolsFor(p, manifest);
    expect(tools.length).toBe(4);
    const skill = tools[3]!;
    expect(skill.name).toBe(skillToolName("Generate a quote PDF"));
    expect(skill.name).toMatch(/^skill_[a-z0-9_]+$/);
    expect(skill.inputSchema).toEqual(manifest.inputSchema);
  });
});
