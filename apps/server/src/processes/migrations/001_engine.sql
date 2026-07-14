-- processes 001_engine — P8: instance bindings on runs + gated pending actions.
-- (000_init is applied and checksum-locked; additions live here.)

create schema if not exists processes;

-- The bindings a run was instantiated with (name → Ref) — watch rules for
-- later graph changes bind against the same case entities.
alter table processes.process_runs
  add column if not exists bindings jsonb not null default '{}'::jsonb;

-- Plans/deltas parked behind a HumanRequest: over-width cascade plans
-- (subjectKind cascade_plan) and proposed instance-graph changes
-- (subjectKind template_change). Resolved requests delete their row.
create table if not exists processes.pending_actions (
  id               text primary key,
  tenant_id        text not null,
  process_run_id   text not null references processes.process_runs (id),
  human_request_id text not null unique,
  kind             text not null,                  -- cascade_plan | graph_change
  payload          jsonb not null,                 -- CascadePlan | GraphDelta
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists pending_actions_run on processes.pending_actions (tenant_id, process_run_id);
