-- spine 000_init — the append-only event log (transactional outbox target)
-- and durable consumer cursors. Matches @lithis/core eventSchema.

create schema if not exists spine;

create table if not exists spine.events (
  id             text primary key,                 -- ulid
  tenant_id      text not null,
  seq            bigint not null,                  -- monotonic per-tenant, assigned by the outbox
  topic          text not null,                    -- dot-namespaced, defineEventType()-registered
  subject_refs   jsonb not null default '[]',      -- Ref[]
  payload        jsonb,
  actor          jsonb not null,                   -- Ref
  causation_id   text,
  correlation_id text,
  severity       text,                             -- info | warning | critical
  at             timestamptz not null,
  prev_hash      text,                             -- optional tamper-evident chain (deferred)
  hash           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, seq)
);

create index if not exists events_tenant_topic_seq on spine.events (tenant_id, topic, seq);
create index if not exists events_correlation on spine.events (correlation_id) where correlation_id is not null;

-- Durable at-least-once subscription checkpoints (one row per consumer).
create table if not exists spine.consumer_cursors (
  consumer_id text not null,
  tenant_id   text not null,
  after_seq   bigint not null default 0,
  selector    jsonb not null default '{}',         -- EventSelector
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (consumer_id, tenant_id)
);
