-- work 000_init — the ONE work graph: items (the job queue itself,
-- FOR UPDATE SKIP LOCKED), edges, and the append-only note journal.
-- Matches @lithis/core work.ts.

create schema if not exists work;

create table if not exists work.work_items (
  id                 text primary key,
  tenant_id          text not null,
  kind               text not null,                -- oneoff | recurring | continuous | process_node
  title              text not null,
  body               text not null default '',
  status             text not null,                -- WORK_ITEM_STATUSES; transitions enforced in code
  owner_principal_id text not null,
  priority           numeric not null default 0.5,
  due_at             timestamptz,
  wake_at            timestamptz,                  -- clock flips pending→ready here
  schedule           text,                         -- cron; recurring items mint oneoff children
  follow_up          jsonb,                        -- { counterpartRef, cadence, nextAt, ... } external-party cadence
  process_run_id     text,                         -- set when kind = process_node
  node_key           text,
  attempt            integer not null default 0,
  lease              jsonb,                        -- { holderPrincipalId, runId, expiresAt, heartbeatAt }
  source_refs        jsonb not null default '[]',  -- Ref[]
  revision           integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- The claim query: ready items by priority, skipping locked rows.
create index if not exists work_items_claimable on work.work_items (tenant_id, status, priority desc);
create index if not exists work_items_process_node on work.work_items (tenant_id, process_run_id, node_key) where process_run_id is not null;
create index if not exists work_items_wake on work.work_items (wake_at) where wake_at is not null;

create table if not exists work.work_edges (
  id         text primary key,
  tenant_id  text not null,
  from_id    text not null references work.work_items (id),
  to_id      text not null references work.work_items (id),
  verb       text not null,                        -- depends_on | subtask_of
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (from_id, to_id, verb)
);

create index if not exists work_edges_to on work.work_edges (tenant_id, to_id);

-- Append-only journal; every insert emits work.note.added.
create table if not exists work.work_notes (
  id           text primary key,
  tenant_id    text not null,
  work_item_id text not null references work.work_items (id),
  at           timestamptz not null,
  by_ref       jsonb not null,                     -- Ref
  kind         text not null,                      -- status | human | system
  text         text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists work_notes_item on work.work_notes (tenant_id, work_item_id, at);
