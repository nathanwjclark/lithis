-- skills 000_init — skill registry (checksum-bound git refs, never source),
-- versions with the capability-creep diff, and report definitions.
-- Matches @lithis/core skills.ts.

create schema if not exists skills;

create table if not exists skills.skills (
  id                 text primary key,
  tenant_id          text not null,
  shared             boolean not null default false, -- shared across tenants
  slug               text not null,
  kind               text not null,                -- tool | report | workflow | ui_capability
  current_version_id text,
  status             text not null,                -- active | retired
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, slug)
);

create table if not exists skills.skill_versions (
  id                  text primary key,
  tenant_id           text not null,
  skill_id            text not null references skills.skills (id),
  semver              text not null,
  source_ref          jsonb not null,              -- GitRef { repo, ref, path } — git is authoritative
  checksum            text not null,               -- activation bound to exactly this content
  manifest            jsonb not null,              -- { description, inputSchema, capabilitiesRequired, triggers?, selfModBounds }
  capability_diff     jsonb not null default '{"added":[],"removed":[]}',
  eval_run_id         text,                        -- must pass before approvable
  approval_request_id text,
  authored_by         jsonb not null,              -- Ref
  status              text not null,               -- proposed | approved | active | retired | rejected
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (skill_id, semver)
);

create table if not exists skills.report_definitions (
  id              text primary key,
  tenant_id       text not null,
  slug            text not null,
  skill_ref       jsonb not null,                  -- Ref
  schedule        text not null,                   -- cron
  audience        jsonb not null default '[]',     -- [{ channel, target }]
  format          text not null default 'markdown',
  approval_policy text not null default 'first_run',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, slug)
);
