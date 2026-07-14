import { z } from "zod";

/**
 * Embedding seam. When OPENAI_API_KEY is set the OpenAI embeddings REST
 * endpoint (model text-embedding-3-small, 1536 dims — matches the
 * context.chunks vector(1536) column) is used via plain fetch; when unset the
 * provider is absent and ingest stores NULL embeddings, degrading search to
 * FTS-only. Tests inject deterministic providers through this same seam —
 * no live API calls in unit or integration tests.
 */

export const EMBEDDING_DIM = 1536;
export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

export interface EmbeddingProvider {
  /** Vector dimensionality — must match the pgvector column (1536). */
  readonly dim: number;
  /** Embed a batch of texts; result[i] corresponds to texts[i]. */
  embed(texts: string[]): Promise<number[][]>;
}

const openAiResponseSchema = z.object({
  data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })),
});

export function createOpenAiEmbeddingProvider(
  apiKey: string,
  opts: { fetchImpl?: typeof fetch; model?: string } = {},
): EmbeddingProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = opts.model ?? OPENAI_EMBEDDING_MODEL;
  return {
    dim: EMBEDDING_DIM,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const res = await fetchImpl(OPENAI_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`openai embeddings request failed (${res.status}): ${body.slice(0, 300)}`);
      }
      const parsed = openAiResponseSchema.parse(await res.json());
      if (parsed.data.length !== texts.length) {
        throw new Error(
          `openai embeddings returned ${parsed.data.length} vectors for ${texts.length} inputs`,
        );
      }
      const out: number[][] = new Array<number[]>(texts.length);
      for (const item of parsed.data) {
        if (item.embedding.length !== EMBEDDING_DIM) {
          throw new Error(
            `openai embedding has ${item.embedding.length} dims, expected ${EMBEDDING_DIM}`,
          );
        }
        out[item.index] = item.embedding;
      }
      return out;
    },
  };
}

/** Serialize a vector as a pgvector literal, e.g. "[0.1,0.2,0.3]". */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
