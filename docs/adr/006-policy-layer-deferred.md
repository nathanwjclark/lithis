# ADR-006: Policy/permissioning layer deferred

## Status

Accepted (2026-07-14). Deliberate deferral — tracked as the first entry in
`TODOS.md`.

## Context

A full permissioning layer — per-principal capability `Grant`s with resource
selectors and rate/budget constraints, standing-approval `Mandate`s minted
from HumanRequest resolutions, and a `PolicyEngine.check()` wired into every
choke point — is an orthogonal ball of yarn. Threading it through the skeleton
would couple every module to a subsystem whose design is not yet settled, and
stall the parts that ARE settled.

## Decision

- `iam` ships **minimal**: Tenant, Principal, AgentCharter, ActionIntent, and
  PrincipalContext only.
- `PolicyEngine` exists as an **unwired stub**
  (`LITHIS-STUB` in `apps/server/src/iam`); the `PolicyDecision` shape
  (allow | deny | require_approval) lives in `@lithis/core` so future wiring
  creates no module cycles. **No other module depends on it yet.**
- Grant and Mandate schemas, `resolution.mintMandate`, ToolBroker
  grant-intersection, and the browser-action capability taxonomy are all
  deferred to TODOS.md.

Interim safety comes from the mechanisms that DID ship: HumanRequest gates at
every risky surface, charter budgets, ToolBroker issuance from
charter + skill manifests, skill `capabilityDiff` + eval + approval, custody
brokering, and the sealed browserhost.

## Consequences

- The skeleton lands without a half-designed authz system fossilized into
  every schema.
- Until the layer lands: no standing approvals (more human clicks — batching
  is the only fatigue mitigation), and capability creep is caught by
  capabilityDiff review rather than enforced grant intersection.
- The deferral is structural honesty: `PolicyEngine.check` throws
  `NotImplementedError` and shows in the stub census, rather than
  silently allowing everything.
- When picked up, wiring points are already named: ToolBroker issuance,
  `Connector.act`, SorRuntime writes, `SkillRegistry.activate`, browserhost
  actions.
