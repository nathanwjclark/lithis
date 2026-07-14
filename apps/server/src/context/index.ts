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
import { stubService } from "@lithis/stubkit";

/**
 * context — ingest, don't curate. Blobs + docs land as-is (quarantined by
 * default); the ingest-time distill pass writes summary + entities + links
 * once; the deterministic index (FTS + pgvector chunks) is built synchronously
 * at ingest and serves association discovery at query time. NO periodic link
 * maintenance jobs. Degree enforcement is QUERY-SIDE: search/paths take a
 * PrincipalContext and an audience filter defaulting to 'network'.
 */

export type NewBlob = Omit<Blob, "id" | "createdAt" | "updatedAt">;
export type NewDoc = Omit<Doc, "id" | "createdAt" | "updatedAt" | "revision" | "summary">;

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
  /** Entity hops from the caller's network to the target. */
  hops: EntityRef[];
  score: number;
  why: string;
}

export interface ContextStore {
  putBlob(b: NewBlob): Promise<BlobRef>;
  /** Quarantined by default; emits context.doc.created. */
  ingestDoc(d: NewDoc): Promise<DocRef>;
  /** ONE LLM pass → summary + entities + links; emits context.doc.distilled. */
  distill(d: DocRef): Promise<DistillResult>;
  /** Hybrid FTS+vector search over the deterministic index; audience defaults 'network'. */
  search(q: SearchQuery, ctx: PrincipalContext): Promise<ScoredRef[]>;
  /** Connection-path ranking over Links × RelationshipScores. */
  paths(target: EntityRef, ctx: PrincipalContext): Promise<RankedPath[]>;
}

const contextStore = stubService<ContextStore>(
  "server.context.store",
  ["putBlob", "ingestDoc", "distill", "search", "paths"],
  "LITHIS-STUB: blob storage, quarantine ingest, distill pass, hybrid FTS+vector search, and path ranking not implemented",
);

export function createContextStore(): ContextStore {
  return contextStore;
}
