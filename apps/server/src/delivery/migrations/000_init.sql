-- delivery 000_init — the delivery ledger: one row per outbound card/digest/nudge.
-- external_id carries the channel-native anchor of the sent thing; for Slack
-- that is "channel:ts", the thread anchor inbound replies resolve against.

create schema if not exists delivery;

create table if not exists delivery.deliveries (
  id               text primary key,
  tenant_id        text not null,
  kind             text not null,             -- human_request | digest | nudge
  channel          text not null,             -- slack | teams | email | portal
  target           text not null,             -- channel-specific address (slack channel id, email, principal)
  human_request_id text,                      -- the HumanRequest a card/nudge is about
  connection_id    text,                      -- the connection whose act() carried it (null when none was available)
  status           text not null,             -- sent | failed
  external_id      text,                      -- upstream anchor ("channel:ts" for slack); null on failure
  detail           text,                      -- receipt detail / failure reason
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Inbound reply → card mapping: find the delivered card a thread reply anchors to.
create index if not exists deliveries_anchor
  on delivery.deliveries (tenant_id, external_id) where external_id is not null;
-- Nudges thread onto the original card; lookups go by request.
create index if not exists deliveries_request
  on delivery.deliveries (tenant_id, human_request_id) where human_request_id is not null;
