-- processes 000_init — templates, runs, instance-bound watch rules.
-- Node state lives on work.work_items (kind process_node) — NO second state
-- machine here. Matches @lithis/core process.ts.

create schema if not exists processes;

create table if not exists processes.process_templates (
  id                  text primary key,
  tenant_id           text not null,
  slug                text not null,
  version             text not null,
  mode                text not null,               -- fixed | adaptive | dynamic
  nodes               jsonb not null,              -- NodeDef[]
  edges               jsonb not null default '[]', -- [{ from, to, kind: 'depends_on' }]
  change_policy       jsonb not null,              -- { allowAddNodes, allowSkip, protectedNodes }
  approval_request_id text,                        -- template changes gate via HumanRequest
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, slug, version)
);

create table if not exists processes.process_runs (
  id             text primary key,
  tenant_id      text not null,
  template_ref   jsonb,                            -- { id, version }; null = fully dynamic
  subject_ref    jsonb not null,                   -- Ref (the case entity, the filing doc, ...)
  status         text not null,                    -- active | paused | done | cancelled
  graph_revision integer not null default 0,       -- bumped on instance-graph changes
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Bound at instantiate(): template selectors × instance bindings.
create table if not exists processes.watch_rules (
  id             text primary key,
  tenant_id      text not null,
  process_run_id text not null references processes.process_runs (id),
  node_key       text not null,
  match          jsonb not null,                   -- { topics, docTypes?, entityRefs?, pathGlobs?, connectorKinds? }
  mode           text not null,                    -- deterministic | interpret
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists watch_rules_run on processes.watch_rules (tenant_id, process_run_id);
