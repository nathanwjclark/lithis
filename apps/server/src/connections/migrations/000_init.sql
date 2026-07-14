-- connections 000_init — connector instances, expected-feed SLAs, and
-- credential records (metadata only — secret material lives in the custody
-- backend, NEVER in these rows). Matches @lithis/core connectivity.ts.

create schema if not exists connections;

create table if not exists connections.connections (
  id             text primary key,
  tenant_id      text not null,
  connector_slug text not null,
  display_name   text not null,
  credential_ref text not null,
  scopes         jsonb not null default '[]',
  status         text not null,                    -- healthy | degraded | expired | disabled
  health         jsonb not null default '{}',      -- { lastOkAt?, lastError? }
  sync_state     jsonb not null default '{"cursorsByFeed":{}}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists connections_slug on connections.connections (tenant_id, connector_slug);

create table if not exists connections.feed_expectations (
  id            text primary key,
  tenant_id     text not null,
  connection_id text not null references connections.connections (id),
  key           text not null,                     -- e.g. "carrier-sftp:loss-runs"
  expect_cadence text not null,                    -- cron
  grace_minutes integer not null default 0,
  last_seen_at  timestamptz,
  missed_count  integer not null default 0,
  on_miss       text not null,                     -- flag | task | both
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (connection_id, key)
);

create table if not exists connections.credentials (
  id                   text primary key,
  tenant_id            text not null,
  kind                 text not null,              -- oauth_token | api_key | password | browser_session
  custody_backend_ref  text not null,              -- WHERE the secret lives (env-file, Secret Manager) — never the value
  holder_connection_id text,
  rotates_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
