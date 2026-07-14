# ADR-002: One human primitive (HumanRequest)

## Status

Accepted (2026-07-14).

## Context

Autonomous agents need humans at many points: gated node results, risky
connector actions, bulk outreach, wide invalidation cascades, skill and
template changes, SoR migrations, watcher findings, and plain questions about
records. Ad-hoc approval flows per feature produce inconsistent UX, unroutable
requests, and unauditable decisions. Separately, chasing EXTERNAL parties
(regulators, carriers) looks superficially similar but has different
mechanics (cadence, escalation to a person, sends via connectors).

## Decision

ONE record — `HumanRequest { kind: approval|question|notification }` — with a
**closed `subjectKind` enum** (node_result, action, action_batch,
cascade_plan, skill_change, template_change, sor_migration, watcher_finding,
record_field), a zod payload pinned per subjectKind, evidence-first rendering,
routing with internal-only SLA/escalation, and a resolution whose `comment`
is always present. `perItem` verdicts let one request resolve a whole
ActionIntent batch. Cascades flip granted requests to `superseded` and notify
the original approvers.

External-party follow-ups are **not** HumanRequests — they live on
`WorkItem.followUp` and execute via approved connector sends.

## Consequences

- One Inbox, one card renderer, one routing/SLA engine, one resolution audit.
- Adding a gated surface = adding a subjectKind (deliberate schema decision),
  not a new subsystem.
- Batch verdicts prevent approval fatigue — the difference between an
  autonomous BD campaign and 40 identical pings.
- The internal/external split means two follow-up mechanisms driven by the
  same clock; keeping them distinct is a documented invariant, not an
  accident.
- Standing approvals (Mandates) are deferred with the policy layer
  (ADR-006); until then, repetitive approvals are mitigated only by batching.
