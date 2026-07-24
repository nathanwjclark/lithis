-- iam 001 — ActionIntent batches go real (P12-browser).
-- 000_init already created iam.action_intents; this adds the batch review
-- back-link and a place to record why an execution failed. Never edit an
-- applied migration — this is the additive follow-up.

alter table iam.action_intents
  add column if not exists human_request_id text,          -- the batch's HumanRequest{action_batch}
  add column if not exists detail           text,          -- executor detail / failure reason
  add column if not exists external_id      text;          -- upstream system's id for what was done

create index if not exists action_intents_human_request
  on iam.action_intents (tenant_id, human_request_id)
  where human_request_id is not null;

create index if not exists action_intents_status
  on iam.action_intents (tenant_id, status);
