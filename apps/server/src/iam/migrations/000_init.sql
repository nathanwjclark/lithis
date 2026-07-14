-- iam 000_init — tenants, principals, agent charters, action intents.
-- Matches @lithis/core iam.ts. Grant/Mandate tables are DEFERRED (TODOS.md).

create schema if not exists iam;

create table if not exists iam.tenants (
  id         text primary key,                     -- ulid
  tenant_id  text not null,                        -- self-reference (= id); kept for the uniform tenancy convention
  slug       text not null unique,
  name       text not null,
  status     text not null,                        -- active | suspended
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists iam.principals (
  id           text primary key,
  tenant_id    text not null,
  kind         text not null,                      -- human | agent | service
  slug         text not null,
  display_name text not null,
  email        text,
  status       text not null,                      -- active | disabled
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, slug)
);

create table if not exists iam.agent_charters (
  principal_id   text primary key references iam.principals (id),
  tenant_id      text not null,
  role           text not null,                    -- the role prompt seed
  prompt_ref     jsonb not null,                   -- Ref to the charter prompt doc
  memory_blob_id text not null,                    -- durable agent notebook
  model_policy   jsonb not null,                   -- { plan, execute, index }
  budgets        jsonb not null,                   -- { usdPerRun, usdPerDay }
  wake           jsonb not null,                   -- { heartbeat?, onEvents?, onMessages }
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists iam.action_intents (
  id              text primary key,
  tenant_id       text not null,
  batch_id        text,                            -- shared by intents reviewed as one HumanRequest
  principal_id    text not null,
  capability      text not null,                   -- dot-namespaced, e.g. gmail.send
  params          jsonb,
  counterpart_ref jsonb,                           -- Ref (entity — the external party)
  status          text not null,                   -- proposed | approved | denied | modified | executing | executed | failed
  receipt_ref     jsonb,                           -- Ref (evidence) once executed
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists action_intents_batch on iam.action_intents (tenant_id, batch_id) where batch_id is not null;
