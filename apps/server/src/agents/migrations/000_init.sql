-- agents 000_init — sessions, runs, run results, evidence.
-- Matches @lithis/core session.ts and runs.ts.

create schema if not exists agents;

create table if not exists agents.sessions (
  id                 text primary key,
  tenant_id          text not null,
  principal_id       text not null,
  kind               text not null,                -- loop | chat | run | workbench
  channel_ref        jsonb,                        -- Ref (slack thread, portal chat, ...)
  transcript_blob_id text,
  started_at         timestamptz not null,
  ended_at           timestamptz,
  summary            text,
  cost               jsonb not null,               -- { tokensIn, tokensOut, usd }
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists agents.runs (
  id                 text primary key,
  tenant_id          text not null,
  principal_id       text not null,
  session_id         text not null references agents.sessions (id),
  work_item_id       text,
  model              text not null,
  trigger            jsonb not null,               -- { cause, eventId? }
  status             text not null,                -- running | done | blocked | human_blocked | needs_decomposition | failed | cancelled
  transcript_blob_id text,
  workspace_ref      jsonb,                        -- Ref
  cost               jsonb not null,
  started_at         timestamptz not null,
  ended_at           timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists runs_work_item on agents.runs (tenant_id, work_item_id) where work_item_id is not null;

create table if not exists agents.run_results (
  id                   text primary key,
  tenant_id            text not null,
  run_id               text not null references agents.runs (id),
  work_item_id         text not null,
  attempt              integer not null default 0,
  result_json          jsonb,                      -- validated vs the node's resultSchemaRef
  summary              text not null,
  evidence_ids         jsonb not null default '[]',
  input_refs           jsonb not null default '[]',-- Ref[]
  inputs_hash          text not null,              -- rerun short-circuit, never an invalidation authority
  superseded           boolean not null default false,
  superseded_by_run_id text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists run_results_item_attempt on agents.run_results (tenant_id, work_item_id, attempt);

-- Immutable, per-attempt, citable — never overwritten.
create table if not exists agents.evidence (
  id           text primary key,
  tenant_id    text not null,
  run_id       text,
  produced_by  jsonb not null,                     -- Ref (principal or run)
  kind         text not null,                      -- excerpt | screenshot | record | metric | page_capture | diff | verification | proposed_action
  sources      jsonb not null,                     -- [{ ref, locator?, excerpt?, whyRelevant }]
  summary      text not null,
  blob_ids     jsonb not null default '[]',
  content_hash text not null,
  at           timestamptz not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
