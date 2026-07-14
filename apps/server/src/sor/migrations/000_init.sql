-- sor 000_init — descriptors for generated systems-of-record. The generated
-- tables themselves live in per-tenant schemas (sor_{tenant}_{slug}) minted by
-- SorRuntime.apply(); every generated table carries _entity_ref + _origin
-- columns. Matches @lithis/core sor.ts.

create schema if not exists sor;

create table if not exists sor.sor_descriptors (
  id           text primary key,
  tenant_id    text not null,
  slug         text not null,                      -- e.g. 'ams'
  display_name text not null,
  version      integer not null default 1,
  tables       jsonb not null,                     -- TableDef[] (columns + entityBindings)
  ddl_blob_id  text,                               -- rendered DDL for the current version
  migrations   jsonb not null default '[]',        -- [{ version, sqlBlobId, appliedBy, approvalRequestId, appliedAt? }]
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, slug)
);
