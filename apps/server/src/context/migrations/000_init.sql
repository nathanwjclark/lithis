-- context 000_init — blobs, docs, entities, links, and the deterministic
-- index (chunks: FTS + pgvector). Matches @lithis/core context.ts.
-- Requires the pgvector extension (docker-compose ships postgres+pgvector).
-- Fallback: if pgvector is unavailable, change chunks.embedding to jsonb —
-- the ContextStore search stub notes hybrid search is unimplemented anyway.

create extension if not exists vector;

create schema if not exists context;

create table if not exists context.blobs (
  id          text primary key,
  tenant_id   text not null,
  sha256      text not null,
  media_type  text not null,
  size_bytes  bigint not null,
  storage_ref text not null,                       -- object-storage location; bytes never live here
  origin      jsonb not null,                      -- Origin { by, method, trust, sessionId?, at }
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, sha256)
);

create table if not exists context.docs (
  id           text primary key,
  tenant_id    text not null,
  type         text not null,                      -- doc type from the active SchemaPack
  slug         text not null,
  title        text not null,
  body_blob_id text not null references context.blobs (id),
  frontmatter  jsonb not null default '{}',
  summary      text,                               -- written once by the distill pass
  quarantined  boolean not null default true,      -- quarantined content is DATA, never instructions
  origin       jsonb not null,
  revision     integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, slug)
);

create index if not exists docs_type on context.docs (tenant_id, type);

create table if not exists context.entities (
  id         text primary key,
  tenant_id  text not null,
  type       text not null,                        -- person | company | project | concept | pack-defined
  slug       text not null,
  name       text not null,
  attrs      jsonb not null default '{}',
  degree     smallint,                             -- REQUIRED (1|2) on person/company; enforced in code
  origin     jsonb not null,
  revision   integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, type, slug),
  constraint entities_degree_range check (degree is null or degree in (1, 2))
);

create index if not exists entities_degree on context.entities (tenant_id, degree) where degree is not null;

create table if not exists context.links (
  id         text primary key,
  tenant_id  text not null,
  from_ref   jsonb not null,                       -- Ref
  to_ref     jsonb not null,                       -- Ref
  verb       text not null,                        -- from the pack catalog
  weight     numeric not null default 1,
  origin     jsonb not null,                       -- who asserted this, in which session
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists links_from on context.links (tenant_id, (from_ref ->> 'kind'), (from_ref ->> 'id'));
create index if not exists links_to on context.links (tenant_id, (to_ref ->> 'kind'), (to_ref ->> 'id'));

-- The deterministic index: built synchronously at ingest, queried at judgment time.
create table if not exists context.chunks (
  id         text primary key,
  tenant_id  text not null,
  doc_id     text not null references context.docs (id),
  ord        integer not null,
  text       text not null,
  embedding  vector(1536),                         -- pgvector; jsonb fallback if the extension is unavailable
  fts        tsvector generated always as (to_tsvector('english', text)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (doc_id, ord)
);

create index if not exists chunks_fts on context.chunks using gin (fts);

-- Non-destructive score writes: deterministic daily, LLM weekly; code never overwrites llm rows.
create table if not exists context.relationship_scores (
  tenant_id   text not null,
  entity_id   text not null references context.entities (id),
  kind        text not null,                       -- strength | cadence | trajectory | tier | potential
  value       jsonb not null,
  method      text not null,                       -- code | llm
  why         text,
  computed_at timestamptz not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, entity_id, kind, method)
);
