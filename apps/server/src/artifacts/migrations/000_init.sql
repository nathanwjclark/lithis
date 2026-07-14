-- artifacts 000_init — templates + rendered/verified artifacts.
-- Matches @lithis/core artifacts.ts. Verification IS Evidence (agents.evidence).

create schema if not exists artifacts;

create table if not exists artifacts.templates (
  id                  text primary key,
  tenant_id           text not null,
  slug                text not null,
  version             text not null,
  kind                text not null,               -- document | image | video | email | report
  fields_schema       jsonb not null default '{}', -- JSON schema for fill-in fields
  body_blob_id        text not null,
  checks              jsonb not null default '[]', -- [{ kind:'deterministic', ref } | { kind:'rubric', prompt }]
  approval_policy     text not null default 'always',
  approval_request_id text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, slug, version)
);

create table if not exists artifacts.artifacts (
  id                 text primary key,
  tenant_id          text not null,
  template_ref       jsonb not null,               -- { id, version }
  inputs_json        jsonb,
  output_blob_id     text not null,
  verification       jsonb,                        -- { passed, findings, evidenceId }
  state              text not null,                -- draft | verified | failed | approved | published
  produced_by_run_id text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists artifacts_state on artifacts.artifacts (tenant_id, state);
