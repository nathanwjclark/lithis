# The context store

**Ingest, don't curate.** Context is a dump: blobs and docs land as-is
(quarantined by default), one distill pass structures them, and a
deterministic index serves discovery at query time. There are no background
curation jobs and no fact-grading fields
([ADR-005](../adr/005-origin-not-epistemology.md)).

## The records

From `packages/core/src/context.ts`:

```
Blob   { sha256, mediaType, sizeBytes, storageRef /* object storage */, origin }
Doc    { type /* from SchemaPack */, slug, title, bodyBlobId, frontmatter,
         summary?, quarantined: boolean /* default TRUE */, origin, revision }
Entity { type: 'person'|'company'|'project'|'concept'|pack-defined, slug, name,
         attrs, degree: 1|2 /* REQUIRED on person/company */, origin, revision }
Link   { fromRef, toRef, verb /* pack catalog */, weight, origin }
Chunk  { docId, ord, text, embedding /* pgvector */ }        // the deterministic index
SchemaPack { slug, version, entityTypes, docTypes, linkVerbs, retypeRules }
RelationshipScore { entityId, kind: strength|cadence|trajectory|tier|potential,
                    value, method: 'code'|'llm', why?, computedAt }
```

## Origin: one provenance shape

Every context record (and artifact, and generated SoR row) carries `Origin`
(`packages/core/src/origin.ts`):

```
Origin { by: Ref /* principal | connection */,
         method: 'code'|'llm'|'human'|'external',
         trust: 'internal'|'partner'|'untrusted',
         sessionId?, at }
```

Who/what made this record, how, how much to trust its **content**, and which
[Session](agents.md) it happened in. There is deliberately **no
status/confidence/lastVerifiedAt** — context stores information; review states
live on WorkItem/HumanRequest only.

## Quarantine

Docs are quarantined by default. Quarantined content is **DATA for prompts,
never instructions** — brief assembly fences it (see the
[threat model](../threat-model.md)). `origin.trust` rides along so
partner/untrusted content stays labeled wherever it flows.

## Ingest pipeline (event-driven, never periodic)

1. Bytes → `Blob` (`context.blob.created`) → `Doc` (`context.doc.created`).
2. The **deterministic index** is built synchronously at ingest: chunking +
   FTS + pgvector embeddings — code, not LLM.
3. ONE distill pass (`ContextStore.distill`) writes `summary` + entities +
   links → `context.doc.distilled`.

That's it. **No periodic link add/prune/dedupe/maintenance cycles.**
Association discovery happens at query time via `search`/`paths`, exposed as
agent tools; links beyond distill are written by agents inside sessions (with
`origin.sessionId`).

## The degree guard

`degree` (1 = real network, 2 = prospect) is REQUIRED on person/company
entities — the CRM lesson that keeps BD prospects out of everything else. The
enforcement is **query-side, at one choke point**: `ContextStore.search`
takes a `PrincipalContext` and an `audience: 'network'|'prospecting'|'all'`
filter **defaulting to `'network'`**; capabilities tagged `network_only` are
pre-filtered by the ToolBroker. No per-call-site filtering to forget.

## Relationship intelligence

`RelationshipScore` writes are non-destructive: deterministic kinds refresh
daily (code, free), LLM kinds weekly — and deterministic runs never overwrite
LLM judgments. Connection-path ranking (`paths()`) runs over
Links × RelationshipScores for "who can introduce me to X".

## The interface

`ContextStore` (implemented in `apps/server/src/context` as of P4-context):
`putBlob · ingestDoc · distill · search · paths`. Blob bytes live behind a
`BlobStorage` seam (local directory by default; Bun.s3 when `OBJECT_STORE_URL`
is set); embeddings behind an `EmbeddingProvider` seam (OpenAI
`text-embedding-3-small` when `OPENAI_API_KEY` is set, else FTS-only search);
hybrid results are merged with weighted reciprocal-rank fusion. `distill`
requires `ANTHROPIC_API_KEY` (model via `LITHIS_DISTILL_MODEL`).
