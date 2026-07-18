-- skills 001_runs — durable skill executions: every trigger firing (schedule
-- tick, agent tool call, manual invoke) lands a row, succeeded or failed,
-- never silent. Result/error are the run's honest outcome payload.

create schema if not exists skills;

create table if not exists skills.skill_runs (
  id          text primary key,
  tenant_id   text not null,
  skill_id    text not null references skills.skills (id),
  version_id  text not null references skills.skill_versions (id),
  trigger     text not null,                 -- schedule | tool | manual
  input       jsonb not null default '{}',
  status      text not null,                 -- running | succeeded | failed
  result      jsonb,
  error       text,
  started_at  timestamptz not null,
  finished_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists skill_runs_by_skill on skills.skill_runs (tenant_id, skill_id, id desc);
