import { describe, expect, test } from "bun:test";
import { createAnthropicComplete, DEFAULT_AGENT_MODEL } from "../../src/agents/executor";

/**
 * Live-LLM smoke test — hits the real Anthropic API and is NOT part of the
 * gate: it skips honestly unless ANTHROPIC_API_KEY is present.
 */

const anthropicKey = process.env["ANTHROPIC_API_KEY"];

describe.skipIf(anthropicKey === undefined || anthropicKey.length === 0)(
  "agent complete() seam against the live Anthropic API",
  () => {
    test(
      "one tool-use turn: the model calls record_result with a summary",
      async () => {
        const complete = createAnthropicComplete(anthropicKey!);
        const turn = await complete(
          {
            model: DEFAULT_AGENT_MODEL,
            system:
              "You are a lithis resident agent. Finish the work item by calling record_result exactly once.",
            maxTokens: 1024,
            messages: [
              {
                role: "user",
                content:
                  "## Work item\nTitle: say hello\nBody: record a result whose summary is a one-line greeting.",
              },
            ],
            tools: [
              {
                name: "record_result",
                description: "Finish the work item with a result summary.",
                input_schema: {
                  type: "object",
                  properties: { summary: { type: "string" } },
                  required: ["summary"],
                  additionalProperties: false,
                },
              },
            ],
          },
          new AbortController().signal,
        );

        expect(turn.usage.inputTokens).toBeGreaterThan(0);
        expect(turn.usage.outputTokens).toBeGreaterThan(0);
        const toolUse = turn.content.find((b) => b.type === "tool_use");
        expect(toolUse).toBeDefined();
        expect((toolUse as { name: string }).name).toBe("record_result");
        const input = (toolUse as { input: { summary?: string } }).input;
        expect(typeof input.summary).toBe("string");
        expect(input.summary!.length).toBeGreaterThan(0);
      },
      60_000,
    );
  },
);
