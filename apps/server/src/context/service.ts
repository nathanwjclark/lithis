import {
  blobSchema,
  docSchema,
  entitySchema,
  linkSchema,
  newUlid,
  nowIso,
  originSchema,
} from "@lithis/core";
import type { Entity, Link, Origin, PrincipalContext, Ref } from "@lithis/core";
import { txSql } from "../db";
import type { Db } from "../db";
import type { EventSpine } from "../spine";
import type { BlobStorage } from "./blobs";
import { chunkText } from "./chunker";
import { buildDistillPrompt, parseDistillAnswer } from "./distill";
import type { DistillLlm } from "./distill";
import { toVectorLiteral } from "./embeddings";
import type { EmbeddingProvider } from "./embeddings";
import { fuseRanked } from "./fusion";
import type {
  BlobRef,
  ContextStore,
  DistillResult,
  DocRef,
  EntityRef,
  NewBlob,
  NewDoc,
  RankedPath,
  ScoredRef,
  SearchQuery,
} from "./index";

/**
 * The Postgres ContextStore: blob storage behind the BlobStorage seam,
 * quarantined doc ingest with a synchronously-built deterministic index
 * (chunks: generated FTS column + optional pgvector embeddings), the ONE
 * ingest-time distill pass, hybrid FTS+vector search fused with weighted RRF,
 * and basic 2-hop connection paths. Every mutation emits its context.* event
 * via spine.append in the SAME transaction (transactional outbox).
 */

export interface ContextStoreDeps {
  blobs: BlobStorage;
  /** Absent (no OPENAI_API_KEY) → chunks store NULL embeddings, search is FTS-only. */
  embeddings?: EmbeddingProvider;
  /** Absent (no ANTHROPIC_API_KEY) → distill() throws a clear config error. */
  distillLlm?: DistillLlm;
}

/** Per-arm candidate pool feeding rank fusion. */
const ARM_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
/** RRF weights per arm — chunks (FTS + vector) dominate; entity-name matches assist. */
const FTS_WEIGHT = 1.0;
const VECTOR_WEIGHT = 1.0;
const ENTITY_WEIGHT = 0.5;
/** Simplification: a 2-hop introduction is worth half a direct one, all else equal. */
const TWO_HOP_DAMPING = 0.5;
const MAX_PATHS = 10;
const DEFAULT_STRENGTH = 0.5;

/** Bun's SQL client returns jsonb columns as JSON text — parse before zod. */
function fromJsonb(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

/**
 * Bun's SQL client does not serialize JS arrays as Postgres arrays — build
 * the text[] literal explicitly (values are slugs, but escape defensively).
 */
function textArrayLiteral(values: string[] | null): string | null {
  if (values === null) return null;
  return `{${values.map((v) => `"${v.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

interface DocRow {
  id: string;
  tenant_id: string;
  type: string;
  slug: string;
  title: string;
  body_blob_id: string;
  summary: string | null;
  origin: unknown;
}

interface EntityRow {
  id: string;
  tenant_id: string;
  type: string;
  slug: string;
  name: string;
  attrs: unknown;
  degree: number | null;
  origin: unknown;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
}

function rowToEntity(row: EntityRow): Entity {
  return entitySchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    slug: row.slug,
    name: row.name,
    attrs: fromJsonb(row.attrs),
    ...(row.degree !== null ? { degree: row.degree } : {}),
    origin: fromJsonb(row.origin),
    revision: row.revision,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

let warnedFtsOnly = false;

export function createPgContextStore(
  db: Db,
  spine: EventSpine,
  deps: ContextStoreDeps,
): ContextStore {
  async function readBlobBytes(tenantId: string, blobId: string): Promise<Uint8Array> {
    // Tenant scoping is in the WHERE clause, not a post-filter: a blob id from
    // another tenant reads as "not found", never as bytes.
    const rows: { storage_ref: string }[] = await db.sql`
      select storage_ref from context.blobs
      where id = ${blobId} and tenant_id = ${tenantId}`;
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`blob ${blobId} not found in tenant ${tenantId}`);
    }
    return await deps.blobs.get(row.storage_ref);
  }

  async function readBlobText(tenantId: string, blobId: string): Promise<string> {
    return new TextDecoder().decode(await readBlobBytes(tenantId, blobId));
  }

  return {
    async readBlob(tenantId: string, blobId: string): Promise<Uint8Array> {
      return await readBlobBytes(tenantId, blobId);
    },

    async putBlob(b: NewBlob, bytes: Uint8Array): Promise<BlobRef> {
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(bytes);
      const sha256 = hasher.digest("hex");

      // Content-addressed dedup: identical bytes in a tenant return the
      // existing ref — no second storage write, no second event.
      const existing: { id: string }[] = await db.sql`
        select id from context.blobs where tenant_id = ${b.tenantId} and sha256 = ${sha256}`;
      if (existing[0] !== undefined) return { kind: "blob", id: existing[0].id };

      const storageRef = await deps.blobs.put(b.tenantId, sha256, bytes);
      const id = newUlid();
      const at = nowIso();
      const blob = blobSchema.parse({
        id,
        tenantId: b.tenantId,
        sha256,
        mediaType: b.mediaType,
        sizeBytes: bytes.byteLength,
        storageRef,
        origin: b.origin,
        createdAt: at,
        updatedAt: at,
      });
      try {
        await db.withTx(async (tx) => {
          await txSql(tx)`
            insert into context.blobs
              (id, tenant_id, sha256, media_type, size_bytes, storage_ref, origin, created_at, updated_at)
            values
              (${blob.id}, ${blob.tenantId}, ${blob.sha256}, ${blob.mediaType},
               ${blob.sizeBytes}, ${blob.storageRef}, ${blob.origin}::jsonb,
               ${at}, ${at})`;
          await spine.append(tx, {
            tenantId: blob.tenantId,
            topic: "context.blob.created",
            subjectRefs: [{ kind: "blob", id: blob.id }],
            actor: blob.origin.by,
            payload: {
              mediaType: blob.mediaType,
              sizeBytes: blob.sizeBytes,
              trust: blob.origin.trust,
            },
          });
        });
      } catch (err) {
        // Concurrent put of the same bytes: the unique(tenant_id, sha256) row
        // won the race — return it (bytes on disk are identical by hash).
        if (err instanceof Error && /duplicate key|blobs_tenant_id_sha256/.test(err.message)) {
          const winner: { id: string }[] = await db.sql`
            select id from context.blobs where tenant_id = ${b.tenantId} and sha256 = ${sha256}`;
          if (winner[0] !== undefined) return { kind: "blob", id: winner[0].id };
        }
        throw err;
      }
      return { kind: "blob", id };
    },

    async ingestDoc(d: NewDoc): Promise<DocRef> {
      const id = newUlid();
      const at = nowIso();
      // docSchema applies the quarantined=true default when the caller omits it.
      const doc = docSchema.parse({ ...d, id, revision: 0, createdAt: at, updatedAt: at });

      // Build the deterministic index synchronously at ingest.
      const text = await readBlobText(doc.tenantId, doc.bodyBlobId);
      const chunks = chunkText(text);
      let vectors: (number[] | null)[] = chunks.map(() => null);
      if (deps.embeddings !== undefined) {
        vectors = await deps.embeddings.embed(chunks);
      } else if (!warnedFtsOnly) {
        warnedFtsOnly = true;
        console.warn(
          "context: no embedding provider configured (OPENAI_API_KEY unset) — " +
            "chunks are stored without vectors and search degrades to FTS-only",
        );
      }

      try {
        await db.withTx(async (tx) => {
          const sql = txSql(tx);
          await sql`
            insert into context.docs
              (id, tenant_id, type, slug, title, body_blob_id, frontmatter,
               summary, quarantined, origin, revision, created_at, updated_at)
            values
              (${doc.id}, ${doc.tenantId}, ${doc.type}, ${doc.slug}, ${doc.title},
               ${doc.bodyBlobId}, ${doc.frontmatter}::jsonb,
               ${doc.summary ?? null}, ${doc.quarantined},
               ${doc.origin}::jsonb, 0, ${at}, ${at})`;
          for (let ord = 0; ord < chunks.length; ord++) {
            const vector = vectors[ord] ?? null;
            await sql`
              insert into context.chunks
                (id, tenant_id, doc_id, ord, text, embedding, created_at, updated_at)
              values
                (${newUlid()}, ${doc.tenantId}, ${doc.id}, ${ord}, ${chunks[ord]!},
                 ${vector === null ? null : toVectorLiteral(vector)}::vector, ${at}, ${at})`;
          }
          await spine.append(tx, {
            tenantId: doc.tenantId,
            topic: "context.doc.created",
            subjectRefs: [{ kind: "doc", id: doc.id }],
            actor: doc.origin.by,
            payload: { docType: doc.type },
          });
        });
      } catch (err) {
        if (err instanceof Error && /duplicate key|docs_tenant_id_slug/.test(err.message)) {
          throw new Error(`doc slug '${doc.slug}' already exists in tenant ${doc.tenantId}`);
        }
        throw err;
      }
      return { kind: "doc", id };
    },

    async distill(d: DocRef): Promise<DistillResult> {
      if (deps.distillLlm === undefined) {
        // Honest config degrade, not a stub: the code path is real but needs a key.
        throw new Error(
          "context.distill requires ANTHROPIC_API_KEY — set it (and optionally " +
            "LITHIS_DISTILL_MODEL) to enable the ingest-time distill pass",
        );
      }
      const rows: DocRow[] = await db.sql`select * from context.docs where id = ${d.id}`;
      const row = rows[0];
      if (row === undefined) throw new Error(`doc ${d.id} not found`);
      if (row.summary !== null) {
        throw new Error(`doc ${d.id} is already distilled — the distill pass runs ONCE per doc`);
      }

      const content = await readBlobText(row.tenant_id, row.body_blob_id);
      const prompt = buildDistillPrompt(
        { type: row.type, slug: row.slug, title: row.title },
        content,
      );
      const output = parseDistillAnswer(await deps.distillLlm(prompt));

      const docOrigin = originSchema.parse(fromJsonb(row.origin));
      const at = nowIso();
      // Distill-derived records: produced by the LLM, content trust inherited
      // from the quarantined source doc.
      const distillOrigin: Origin = {
        by: docOrigin.by,
        method: "llm",
        trust: docOrigin.trust,
        at,
      };

      return await db.withTx(async (tx) => {
        const sql = txSql(tx);
        const updated: { id: string }[] = await sql`
          update context.docs
          set summary = ${output.summary}, revision = revision + 1, updated_at = ${at}
          where id = ${row.id} and summary is null
          returning id`;
        if (updated.length === 0) {
          throw new Error(`doc ${d.id} was distilled concurrently — summary is written once`);
        }

        // Upsert entities on unique(tenant_id, type, slug); existing entities
        // are NOT overwritten (non-destructive) and emit no event.
        const entityByKey = new Map<string, Entity>();
        for (const e of output.entities) {
          const key = `${e.type}:${e.slug}`;
          if (entityByKey.has(key)) continue;
          const entityId = newUlid();
          const inserted: { id: string }[] = await sql`
            insert into context.entities
              (id, tenant_id, type, slug, name, attrs, degree, origin, revision, created_at, updated_at)
            values
              (${entityId}, ${row.tenant_id}, ${e.type}, ${e.slug}, ${e.name},
               ${e.attrs ?? {}}::jsonb, ${e.degree ?? null},
               ${distillOrigin}::jsonb, 0, ${at}, ${at})
            on conflict (tenant_id, type, slug) do nothing
            returning id`;
          if (inserted.length > 0) {
            entityByKey.set(
              key,
              entitySchema.parse({
                id: entityId,
                tenantId: row.tenant_id,
                type: e.type,
                slug: e.slug,
                name: e.name,
                attrs: e.attrs ?? {},
                ...(e.degree !== undefined ? { degree: e.degree } : {}),
                origin: distillOrigin,
                revision: 0,
                createdAt: at,
                updatedAt: at,
              }),
            );
            await spine.append(tx, {
              tenantId: row.tenant_id,
              topic: "context.entity.created",
              subjectRefs: [{ kind: "entity", id: entityId }],
              actor: distillOrigin.by,
              payload: {
                entityType: e.type,
                ...(e.degree !== undefined ? { degree: e.degree } : {}),
              },
            });
          } else {
            const existingRows: EntityRow[] = await sql`
              select * from context.entities
              where tenant_id = ${row.tenant_id} and type = ${e.type} and slug = ${e.slug}`;
            entityByKey.set(key, rowToEntity(existingRows[0]!));
          }
        }

        // Model-asserted links, plus one deterministic doc→entity 'mentions'
        // link per extracted entity (the base edges audience filtering and
        // paths run over). Links referencing entities the model failed to
        // extract are dropped loudly.
        const resolveRef = (linkKey: string): Ref | undefined => {
          if (linkKey === "doc") return { kind: "doc", id: row.id };
          const entity = entityByKey.get(linkKey);
          return entity === undefined ? undefined : { kind: "entity", id: entity.id };
        };
        const specs: { fromRef: Ref; toRef: Ref; verb: string; weight: number }[] = [];
        const seen = new Set<string>();
        const pushSpec = (fromRef: Ref, toRef: Ref, verb: string, weight: number): void => {
          const dedupKey = `${fromRef.kind}:${fromRef.id}|${toRef.kind}:${toRef.id}|${verb}`;
          if (seen.has(dedupKey)) return;
          seen.add(dedupKey);
          specs.push({ fromRef, toRef, verb, weight });
        };
        for (const l of output.links) {
          const fromRef = resolveRef(l.from);
          const toRef = resolveRef(l.to);
          if (fromRef === undefined || toRef === undefined) {
            console.warn(
              `context.distill: dropping link ${l.from} -[${l.verb}]-> ${l.to} on doc ${row.id} — references an entity the model did not extract`,
            );
            continue;
          }
          pushSpec(fromRef, toRef, l.verb, l.weight ?? 1);
        }
        for (const entity of entityByKey.values()) {
          pushSpec({ kind: "doc", id: row.id }, { kind: "entity", id: entity.id }, "mentions", 1);
        }

        const links: Link[] = [];
        for (const spec of specs) {
          const linkId = newUlid();
          const link = linkSchema.parse({
            id: linkId,
            tenantId: row.tenant_id,
            fromRef: spec.fromRef,
            toRef: spec.toRef,
            verb: spec.verb,
            weight: spec.weight,
            origin: distillOrigin,
            createdAt: at,
            updatedAt: at,
          });
          await sql`
            insert into context.links
              (id, tenant_id, from_ref, to_ref, verb, weight, origin, created_at, updated_at)
            values
              (${link.id}, ${link.tenantId}, ${link.fromRef}::jsonb,
               ${link.toRef}::jsonb, ${link.verb}, ${link.weight},
               ${link.origin}::jsonb, ${at}, ${at})`;
          await spine.append(tx, {
            tenantId: row.tenant_id,
            topic: "context.link.created",
            subjectRefs: [{ kind: "link", id: link.id }],
            actor: distillOrigin.by,
            payload: { verb: link.verb },
          });
          links.push(link);
        }

        const entities = [...entityByKey.values()];
        await spine.append(tx, {
          tenantId: row.tenant_id,
          topic: "context.doc.distilled",
          subjectRefs: [{ kind: "doc", id: row.id }],
          actor: distillOrigin.by,
          payload: { entityIds: entities.map((e) => e.id), linkIds: links.map((l) => l.id) },
        });

        return { docId: row.id, summary: output.summary, entities, links };
      });
    },

    async search(q: SearchQuery, ctx: PrincipalContext): Promise<ScoredRef[]> {
      const audience = q.audience ?? "network";
      const limit = Math.max(1, Math.min(q.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT));
      const docTypes = textArrayLiteral(q.docTypes ?? null);
      const entityTypes = textArrayLiteral(q.entityTypes ?? null);

      // ── FTS arm over chunks ──────────────────────────────────────────────
      // The audience choke point (docs): a doc counts as prospect material
      // when any context.link ties it to a degree-2 entity. 'network' (the
      // default) excludes those docs, 'prospecting' returns ONLY those docs,
      // 'all' skips the filter. Docs with no entity links yet (pre-distill)
      // have no degree signal and are treated as network material.
      // `(audience='network') <> exists(...)`: network needs exists=false,
      // prospecting needs exists=true.
      interface ChunkHit {
        doc_id: string;
        excerpt: string;
      }
      const ftsRows: ChunkHit[] = await db.sql`
        select c.doc_id,
               ts_headline('english', c.text, websearch_to_tsquery('english', ${q.text}),
                           'MaxWords=30, MinWords=10') as excerpt
        from context.chunks c
        join context.docs d on d.id = c.doc_id
        where c.tenant_id = ${ctx.tenantId}
          and c.fts @@ websearch_to_tsquery('english', ${q.text})
          and (${docTypes}::text[] is null or d.type = any(${docTypes}::text[]))
          and (
            ${audience}::text = 'all'
            or (${audience}::text = 'network') <> exists (
              select 1 from context.links l
              join context.entities e on e.tenant_id = l.tenant_id
                and ((l.from_ref->>'kind' = 'entity' and e.id = l.from_ref->>'id')
                  or (l.to_ref->>'kind' = 'entity' and e.id = l.to_ref->>'id'))
              where l.tenant_id = d.tenant_id
                and ((l.from_ref->>'kind' = 'doc' and l.from_ref->>'id' = d.id)
                  or (l.to_ref->>'kind' = 'doc' and l.to_ref->>'id' = d.id))
                and e.degree = 2
            )
          )
        order by ts_rank(c.fts, websearch_to_tsquery('english', ${q.text})) desc, c.doc_id, c.ord
        limit ${ARM_LIMIT}`;

      // ── vector arm (cosine distance) when a query embedding is available ─
      let vectorRows: { doc_id: string; text: string }[] = [];
      if (deps.embeddings !== undefined) {
        const [queryVector] = await deps.embeddings.embed([q.text]);
        const literal = toVectorLiteral(queryVector!);
        vectorRows = await db.sql`
          select c.doc_id, c.text
          from context.chunks c
          join context.docs d on d.id = c.doc_id
          where c.tenant_id = ${ctx.tenantId}
            and c.embedding is not null
            and (${docTypes}::text[] is null or d.type = any(${docTypes}::text[]))
            and (
              ${audience}::text = 'all'
              or (${audience}::text = 'network') <> exists (
                select 1 from context.links l
                join context.entities e on e.tenant_id = l.tenant_id
                  and ((l.from_ref->>'kind' = 'entity' and e.id = l.from_ref->>'id')
                    or (l.to_ref->>'kind' = 'entity' and e.id = l.to_ref->>'id'))
                where l.tenant_id = d.tenant_id
                  and ((l.from_ref->>'kind' = 'doc' and l.from_ref->>'id' = d.id)
                    or (l.to_ref->>'kind' = 'doc' and l.to_ref->>'id' = d.id))
                  and e.degree = 2
              )
            )
          order by c.embedding <=> ${literal}::vector, c.doc_id, c.ord
          limit ${ARM_LIMIT}`;
      }

      // ── entity-name arm; audience applies directly to entity.degree ─────
      const entityRows: { id: string; name: string }[] = await db.sql`
        select e.id, e.name
        from context.entities e
        where e.tenant_id = ${ctx.tenantId}
          and to_tsvector('english', e.name || ' ' || replace(e.slug, '-', ' '))
              @@ websearch_to_tsquery('english', ${q.text})
          and (${entityTypes}::text[] is null or e.type = any(${entityTypes}::text[]))
          and (
            ${audience}::text = 'all'
            or (${audience}::text = 'network' and (e.degree is null or e.degree = 1))
            or (${audience}::text = 'prospecting' and e.degree = 2)
          )
        order by ts_rank(to_tsvector('english', e.name || ' ' || replace(e.slug, '-', ' ')),
                         websearch_to_tsquery('english', ${q.text})) desc, e.id
        limit ${ARM_LIMIT}`;

      // ── weighted RRF fusion (see fusion.ts) ──────────────────────────────
      const excerptByDoc = new Map<string, string>();
      const ftsDocs: string[] = [];
      for (const r of ftsRows) {
        if (!excerptByDoc.has(r.doc_id)) {
          excerptByDoc.set(r.doc_id, r.excerpt);
          ftsDocs.push(r.doc_id);
        }
      }
      const vectorDocs: string[] = [];
      for (const r of vectorRows) {
        if (!vectorDocs.includes(r.doc_id)) {
          vectorDocs.push(r.doc_id);
          if (!excerptByDoc.has(r.doc_id)) {
            excerptByDoc.set(r.doc_id, r.text.slice(0, 200));
          }
        }
      }
      const entityNameById = new Map(entityRows.map((r) => [r.id, r.name]));

      const fused = fuseRanked([
        { weight: FTS_WEIGHT, keys: ftsDocs.map((docId) => `doc:${docId}`) },
        { weight: VECTOR_WEIGHT, keys: vectorDocs.map((docId) => `doc:${docId}`) },
        { weight: ENTITY_WEIGHT, keys: entityRows.map((r) => `entity:${r.id}`) },
      ]);

      return fused.slice(0, limit).map(({ key, score }) => {
        const sep = key.indexOf(":");
        const kind = key.slice(0, sep) as "doc" | "entity";
        const refId = key.slice(sep + 1);
        const excerpt = kind === "doc" ? excerptByDoc.get(refId) : entityNameById.get(refId);
        return {
          ref: { kind, id: refId },
          score,
          ...(excerpt !== undefined ? { excerpt } : {}),
        };
      });
    },

    async paths(target: EntityRef, ctx: PrincipalContext): Promise<RankedPath[]> {
      interface EntityNode {
        id: string;
        name: string;
        degree: number | null;
      }
      const entityRows: { id: string; name: string; degree: number | null }[] = await db.sql`
        select id, name, degree from context.entities where tenant_id = ${ctx.tenantId}`;
      const nodes = new Map<string, EntityNode>(entityRows.map((r) => [r.id, r]));
      const targetNode = nodes.get(target.id);
      if (targetNode === undefined) {
        throw new Error(`paths: entity ${target.id} not found in tenant ${ctx.tenantId}`);
      }

      // Entity↔entity links only; treated as UNDIRECTED (an introduction can
      // flow either way along a known relationship) — a simplification.
      const linkRows: { from_ref: unknown; to_ref: unknown; verb: string; weight: unknown }[] =
        await db.sql`
          select from_ref, to_ref, verb, weight from context.links
          where tenant_id = ${ctx.tenantId}
            and from_ref->>'kind' = 'entity' and to_ref->>'kind' = 'entity'`;
      interface Edge {
        other: string;
        verb: string;
        weight: number;
      }
      const adjacency = new Map<string, Edge[]>();
      const addEdge = (a: string, b: string, verb: string, weight: number): void => {
        const list = adjacency.get(a) ?? [];
        list.push({ other: b, verb, weight });
        adjacency.set(a, list);
      };
      for (const l of linkRows) {
        const fromRef = fromJsonb(l.from_ref) as Ref;
        const toRef = fromJsonb(l.to_ref) as Ref;
        const weight = Number(l.weight);
        addEdge(fromRef.id, toRef.id, l.verb, weight);
        addEdge(toRef.id, fromRef.id, l.verb, weight);
      }

      // Relationship strength: llm judgments win over code refreshes.
      const scoreRows: { entity_id: string; value: unknown; method: string }[] = await db.sql`
        select entity_id, value, method from context.relationship_scores
        where tenant_id = ${ctx.tenantId} and kind = 'strength'
        order by case method when 'code' then 0 else 1 end`;
      const strength = new Map<string, number>();
      for (const s of scoreRows) {
        const value = fromJsonb(s.value);
        if (typeof value === "number") strength.set(s.entity_id, value);
      }
      const strengthOf = (id: string): number => strength.get(id) ?? DEFAULT_STRENGTH;

      // BFS up to 2 hops from every degree-1 entity toward the target.
      // Intermediates that are themselves prospects (degree 2) are excluded —
      // you cannot route an introduction through someone you don't know.
      const best = new Map<string, RankedPath>();
      const consider = (hops: EntityRef[], score: number, why: string): void => {
        const key = hops.map((h) => h.id).join(">");
        const existing = best.get(key);
        if (existing === undefined || existing.score < score) {
          best.set(key, { hops, score, why });
        }
      };
      const starts = [...nodes.values()].filter((n) => n.degree === 1 && n.id !== target.id);
      for (const start of starts) {
        const s = strengthOf(start.id);
        for (const e1 of adjacency.get(start.id) ?? []) {
          if (e1.other === target.id) {
            consider(
              [
                { kind: "entity", id: start.id },
                { kind: "entity", id: target.id },
              ],
              s * e1.weight,
              `${start.name} (strength ${s.toFixed(2)}) — ${e1.verb} → ${targetNode.name}`,
            );
            continue;
          }
          const mid = nodes.get(e1.other);
          if (mid === undefined || mid.degree === 2) continue;
          for (const e2 of adjacency.get(e1.other) ?? []) {
            if (e2.other !== target.id) continue;
            consider(
              [
                { kind: "entity", id: start.id },
                { kind: "entity", id: mid.id },
                { kind: "entity", id: target.id },
              ],
              s * e1.weight * e2.weight * TWO_HOP_DAMPING,
              `${start.name} (strength ${s.toFixed(2)}) — ${e1.verb} → ${mid.name} — ${e2.verb} → ${targetNode.name}`,
            );
          }
        }
      }
      return [...best.values()]
        .sort((a, b) => b.score - a.score || a.why.localeCompare(b.why))
        .slice(0, MAX_PATHS);
    },
  };
}
