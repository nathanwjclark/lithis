import { describe, expect, test } from "bun:test";
import {
  buildDistillPrompt,
  createAnthropicDistillLlm,
  parseDistillAnswer,
} from "../../src/context/distill";
import { createOpenAiEmbeddingProvider, EMBEDDING_DIM } from "../../src/context/embeddings";

/**
 * Live-LLM smoke tests — they hit real APIs and are NOT part of the gate:
 * each suite skips unless its key is present in the environment.
 */

const anthropicKey = process.env["ANTHROPIC_API_KEY"];
const openaiKey = process.env["OPENAI_API_KEY"];

describe.skipIf(anthropicKey === undefined || anthropicKey.length === 0)(
  "distill against the live Anthropic API",
  () => {
    test(
      "distills a small fixture email into the JSON contract",
      async () => {
        const llm = createAnthropicDistillLlm(anthropicKey!);
        const prompt = buildDistillPrompt(
          { type: "email", slug: "live-smoke", title: "Renewal question" },
          "Hi, this is Jane Doe from Acme Corp. Could you send the renewal quote for our property coverage before Friday? Thanks, Jane",
        );
        const output = parseDistillAnswer(await llm(prompt));
        expect(output.summary.length).toBeGreaterThan(10);
        const person = output.entities.find((e) => e.type === "person");
        expect(person).toBeDefined();
        expect(person!.degree === 1 || person!.degree === 2).toBe(true);
      },
      60_000,
    );
  },
);

describe.skipIf(openaiKey === undefined || openaiKey.length === 0)(
  "embeddings against the live OpenAI API",
  () => {
    test(
      "returns 1536-dim vectors where similar texts are closer",
      async () => {
        const provider = createOpenAiEmbeddingProvider(openaiKey!);
        const [a, b, c] = await provider.embed([
          "quarterly loss runs for the trucking fleet",
          "loss history report for our truck fleet",
          "the venue for the team offsite is a zoo",
        ]);
        expect(a!.length).toBe(EMBEDDING_DIM);
        const dot = (x: number[], y: number[]): number =>
          x.reduce((sum, xi, i) => sum + xi * y[i]!, 0);
        expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
      },
      60_000,
    );
  },
);
