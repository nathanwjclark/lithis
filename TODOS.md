# TODOS — deferred projects

Deliberately-parked workstreams. Each was considered during the initial architecture design
(2026-07-14) and deferred on purpose; don't re-litigate the deferral casually, but don't let
these rot either.

## 1. Policy & permissioning layer (the big one)

De-emphasized by design decision 2026-07-14: it's an orthogonal ball of yarn, so the `iam`
module ships with Tenant/Principal/AgentCharter only, and `PolicyEngine` exists as an
**unwired stub** that no other module depends on yet. When we pick this up:

- `Grant` schema: per-principal capability grants ('gmail.send', 'browser.linkedin.connect',
  'sor.ams.write', 'skills.modify') with resource selectors, rate/budget/hours constraints,
  and approvalMode (never | always | auto_below_threshold).
- `Mandate` schema: standing approvals minted from a HumanRequest resolution ("may email
  NJ-DOBI monthly"), with limits (maxActions, perDay, expiresAt) and exhaustion/revocation.
  Re-add `resolution.mintMandate` to HumanRequest when this lands.
- Wire `PolicyEngine.check` into the choke points (ToolBroker tool issuance, Connector.act,
  SorRuntime writes, SkillRegistry.activate, browserhost actions) — allow / deny /
  require_approval routed through the existing HumanGate.
- ToolBroker: intersect charter/skill-manifest tools with grants (capability-creep check
  currently relies on skill capabilityDiff + human review alone).
- Decide the browser-action capability taxonomy (read vs write vs outreach).

## 2. Later / smaller

- **License confirmation** — Apache-2.0 chosen as default; confirm or switch to MIT before
  first external contribution.
- **Tamper-evident event chain** — `Event.prevHash/hash` fields exist in the schema; actual
  chaining + verification job is unbuilt.
- **Browserhost egress policy** — unrestricted egress for browser sessions today (same
  trade-off as the cass/openclaw deployment); revisit if browser use narrows to allowlistable
  portals or a per-request approval flow lands at the browser layer.
- **Entity resolution pipeline** — staged deterministic→LLM-gated merge (crm's
  resolve-entities/resolve-fuzzy pattern) is not in the skeleton; needed once multiple
  connectors feed overlapping people/companies.
- **Fact-grading / epistemology layer** — explicitly removed from the context core
  (2026-07-14): context just stores information. If confidence tracking is ever wanted, it
  returns as an optional overlay, not core schema.
