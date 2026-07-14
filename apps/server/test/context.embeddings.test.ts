import { describe, expect, test } from "bun:test";
import {
  createOpenAiEmbeddingProvider,
  EMBEDDING_DIM,
  OPENAI_EMBEDDING_MODEL,
  toVectorLiteral,
} from "../src/context/embeddings";
import { contextDepsFromConfig } from "../src/context";
import { loadConfig } from "../src/config";

function fixtureVector(fill: number): number[] {
  return new Array<number>(EMBEDDING_DIM).fill(fill);
}

describe("createOpenAiEmbeddingProvider (fetch fixture — no live API)", () => {
  test("posts texts and returns vectors ordered by index", async () => {
    let captured: { url: string; body: unknown; headers: Record<string, string> } | undefined;
    const fetchImpl = (async (url: URL | RequestInfo, init?: RequestInit) => {
      captured = {
        url: String(url),
        body: JSON.parse(String(init!.body)),
        headers: init!.headers as Record<string, string>,
      };
      // deliberately out of order — the provider must reorder by index
      return new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: fixtureVector(0.2) },
            { index: 0, embedding: fixtureVector(0.1) },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const provider = createOpenAiEmbeddingProvider("sk-openai-test", { fetchImpl });
    const out = await provider.embed(["first", "second"]);
    expect(out[0]![0]).toBeCloseTo(0.1);
    expect(out[1]![0]).toBeCloseTo(0.2);
    expect(provider.dim).toBe(EMBEDDING_DIM);
    expect(captured!.url).toBe("https://api.openai.com/v1/embeddings");
    expect(captured!.headers["authorization"]).toBe("Bearer sk-openai-test");
    expect(captured!.body).toEqual({ model: OPENAI_EMBEDDING_MODEL, input: ["first", "second"] });
  });

  test("empty batch short-circuits without a network call", async () => {
    const fetchImpl = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    const provider = createOpenAiEmbeddingProvider("k", { fetchImpl });
    expect(await provider.embed([])).toEqual([]);
  });

  test("throws with status + body on HTTP failure", async () => {
    const fetchImpl = (async () =>
      new Response('{"error": {"code": "invalid_api_key"}}', { status: 401 })) as unknown as typeof fetch;
    const provider = createOpenAiEmbeddingProvider("bad", { fetchImpl });
    expect(provider.embed(["x"])).rejects.toThrow(/401.*invalid_api_key/);
  });

  test("throws on a dimension mismatch instead of storing wrong vectors", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const provider = createOpenAiEmbeddingProvider("k", { fetchImpl });
    expect(provider.embed(["x"])).rejects.toThrow(/3 dims, expected 1536/);
  });

  test("throws when the count of vectors does not match the inputs", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    const provider = createOpenAiEmbeddingProvider("k", { fetchImpl });
    expect(provider.embed(["x", "y"])).rejects.toThrow(/0 vectors for 2 inputs/);
  });
});

describe("embedding degrade wiring", () => {
  test("no OPENAI_API_KEY → no embeddings provider (search degrades to FTS-only)", () => {
    const deps = contextDepsFromConfig(loadConfig({}));
    expect(deps.embeddings).toBeUndefined();
  });

  test("OPENAI_API_KEY set → provider present with the pgvector dimensionality", () => {
    const deps = contextDepsFromConfig(loadConfig({ OPENAI_API_KEY: "sk-test" }));
    expect(deps.embeddings).toBeDefined();
    expect(deps.embeddings!.dim).toBe(EMBEDDING_DIM);
  });

  test("no ANTHROPIC_API_KEY → no distill llm; key set → present", () => {
    expect(contextDepsFromConfig(loadConfig({})).distillLlm).toBeUndefined();
    expect(
      contextDepsFromConfig(loadConfig({ ANTHROPIC_API_KEY: "sk-ant" })).distillLlm,
    ).toBeDefined();
  });
});

describe("toVectorLiteral", () => {
  test("serializes the pgvector literal form", () => {
    expect(toVectorLiteral([0.1, -2, 3])).toBe("[0.1,-2,3]");
  });
});
