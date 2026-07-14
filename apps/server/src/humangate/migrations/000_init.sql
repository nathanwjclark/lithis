-- humangate 000_init — the ONE human-in-the-loop primitive.
-- Matches @lithis/core humangate.ts; state transitions enforced in code.

create schema if not exists humangate;

create table if not exists humangate.human_requests (
  id           text primary key,
  tenant_id    text not null,
  kind         text not null,                      -- approval | question | notification
  subject_kind text not null,                      -- CLOSED enum (node_result, action, action_batch, cascade_plan, ...)
  subject_ref  jsonb not null,                     -- Ref
  payload      jsonb,                              -- shape pinned per subject_kind
  evidence_ids jsonb not null default '[]',
  summary      text not null,
  options      jsonb,                              -- preset choices rendered as buttons
  routing      jsonb not null,                     -- { assignee, channelPrefs, slaHours?, escalationPath, followUpCount, nextFollowUpAt? }
  state        text not null,                      -- HUMAN_REQUEST_STATES
  resolution   jsonb,                              -- { by, at, verdict, comment, modification?, perItem? }
  requested_by jsonb not null,                     -- Ref
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists human_requests_pending on humangate.human_requests (tenant_id, state) where state = 'pending';
-- The clock's SLA sweep: pending requests whose next follow-up is due.
create index if not exists human_requests_follow_up on humangate.human_requests (((routing ->> 'nextFollowUpAt'))) where state = 'pending';
