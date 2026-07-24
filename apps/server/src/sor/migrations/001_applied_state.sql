-- sor 001 — separate the DECLARED descriptor from the APPLIED schema.
--
-- sor_descriptors.tables/version describe what the descriptor currently
-- DECLARES (the newest proposal). applied_tables/applied_version describe what
-- has actually been migrated into the sor_{tenant}_{slug} schema. propose()
-- diffs the declaration against applied_tables, so a denied or still-pending
-- proposal can never be mistaken for live schema, and apply() advances the
-- applied_* pair inside the same transaction as the DDL.
--
-- The audit trail itself stays where docs/concepts/sor.md puts it: the
-- descriptor's own `migrations` array, whose entries gain `appliedAt` on apply.

alter table sor.sor_descriptors
  add column if not exists applied_tables  jsonb,
  add column if not exists applied_version integer,
  -- Cached for operators: the Postgres schema this system's tables live in.
  add column if not exists schema_name     text;
