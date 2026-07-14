import type {
  Audience,
  Blob,
  Doc,
  Entity,
  Link,
  PrincipalContext,
  Ref,
  Ulid,
} from "@lithis/core";
import type { Db } from "../db";
import type { EventSpine } from "../spine";
import type { ServerConfig } from "../config";
import {
  createLocalBlobStorage,
  createS3BlobStorage,
  DEFAULT_BLOB_BUCKET,
  DEFAULT_BLOB_DIR,
} from "./blobs";
import { createAnthropicDistillLlm } from "./distill";
import { createOpenAiEmbeddingProvider } from "./embeddings";
import { createPgContextStore } from "./service";
import type { ContextStoreDeps } from "./service";

/**
 * context — ingest, don't curate. Blobs + docs land as-is (quarantined by
 * default); the ingest-time distill pass writes summary + entities + links
 * once; the deterministic index (FTS + pgvector chunks) is built synchronously
 * at ingest and serves association discovery at query time. NO periodic link
 * maintenance jobs. Degree enforcement is QUERY-SIDE: search/paths take a
 * PrincipalContext and an audience filter defaulting to 'network'.
 *
 * REAL as of phase P4 — see service.ts (store), blobs.ts (storage drivers),
 * chunker.ts (deterministic index), distill.ts (the one LLM pass),
 * embeddings.ts (vector seam), fusion.ts (hybrid-search scoring).
 */

/**
 * Input for putBlob. The core Blob schema carries no bytes field (bytes never
 * live in Postgres), so the store takes metadata + bytes separately and
 * derives sha256/sizeBytes/storageRef itself.
 */
export type NewBlob = Pick<Blob, "tenantId" | "mediaType" | "origin">;
export type NewDoc = Omit<
  Doc,
  "id" | "createdAt" | "updatedAt" | "revision" | "summary" | "quarantined"
> & { quarantined?: boolean };

export type BlobRef = Ref & { kind: "blob" };
export type DocRef = Ref & { kind: "doc" };
export type EntityRef = Ref & { kind: "entity" };

/** What the ONE ingest-time LLM pass produced. */
export interface DistillResult {
  docId: Ulid;
  summary: string;
  entities: Entity[];
  links: Link[];
}

export interface SearchQuery {
  text: string;
  /** The degree choke point — defaults to 'network'. */
  audience?: Audience;
  docTypes?: string[];
  entityTypes?: string[];
  limit?: number;
}

export interface ScoredRef {
  ref: Ref;
  score: number;
  /** Snippet/locator explaining why this matched. */
  excerpt?: string;
}

/** A connection path to a target entity, ranked by relationship strength. */
export interface RankedPath {
  /** Entity hops from the caller's network to the target (target included last). */
  hops: EntityRef[];
  score: number;
  why: string;
}

export interface ContextStore {
  /** Content-addressed (sha256) + deduped per tenant; emits context.blob.created. */
  putBlob(b: NewBlob, bytes: Uint8Array): Promise<BlobRef>;
  /** Quarantined by default; builds the deterministic index; emits context.doc.created. */
  ingestDoc(d: NewDoc): Promise<DocRef>;
  /** ONE LLM pass → summary + entities + links; emits context.doc.distilled. */
  distill(d: DocRef): Promise<DistillResult>;
  /** Hybrid FTS+vector search over the deterministic index; audience defaults 'network'. */
  search(q: SearchQuery, ctx: PrincipalContext): Promise<ScoredRef[]>;
  /** Connection-path ranking over Links × RelationshipScores. */
  paths(target: EntityRef, ctx: PrincipalContext): Promise<RankedPath[]>;
}

export type { ContextStoreDeps } from "./service";
export type { BlobStorage } from "./blobs";
export { createLocalBlobStorage, createS3BlobStorage } from "./blobs";
export type { EmbeddingProvider } from "./embeddings";
export { createOpenAiEmbeddingProvider } from "./embeddings";
export type { DistillLlm } from "./distill";
export { createAnthropicDistillLlm, DEFAULT_DISTILL_MODEL } from "./distill";

export function createContextStore(
  db: Db,
  spine: EventSpine,
  deps: ContextStoreDeps,
): ContextStore {
  return createPgContextStore(db, spine, deps);
}

/**
 * Default deps from server config: S3 blob driver when OBJECT_STORE_URL is
 * set, else the local-directory driver (LITHIS_BLOB_DIR, default var/blobs);
 * OpenAI embeddings when OPENAI_API_KEY is set (else FTS-only search);
 * Anthropic distill when ANTHROPIC_API_KEY is set (else distill() throws a
 * clear config error).
 */
export function contextDepsFromConfig(config: ServerConfig): ContextStoreDeps {
  const blobs =
    config.objectStoreUrl !== undefined
      ? createS3BlobStorage(config.objectStoreUrl, config.blobBucket ?? DEFAULT_BLOB_BUCKET)
      : createLocalBlobStorage(config.blobDir ?? DEFAULT_BLOB_DIR);
  return {
    blobs,
    ...(config.openaiApiKey !== undefined
      ? { embeddings: createOpenAiEmbeddingProvider(config.openaiApiKey) }
      : {}),
    ...(config.anthropicApiKey !== undefined
      ? {
          distillLlm: createAnthropicDistillLlm(config.anthropicApiKey, {
            ...(config.distillModel !== undefined ? { model: config.distillModel } : {}),
          }),
        }
      : {}),
  };
}

/**
 * DB-less skeleton mode (DATABASE_URL unset): the context store cannot run.
 * This is honest CONFIG degrade — every method throws a clear error naming
 * the missing configuration. It is not a stub: the real implementation exists
 * and is wired whenever a database is configured.
 */
export function createUnconfiguredContextStore(): ContextStore {
  const fail = (): never => {
    throw new Error(
      "context store unavailable: DATABASE_URL is not set — the server is running in DB-less skeleton mode",
    );
  };
  return { putBlob: fail, ingestDoc: fail, distill: fail, search: fail, paths: fail };
}
