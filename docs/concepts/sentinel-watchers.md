# Sentinel watchers

Compliance, model welfare, security, and data-quality watching are implemented
as **ordinary agents** — not framework schemas, not hardcoded rule engines.

## Watchers are ordinary agents

A watcher is a `Principal { kind: 'agent' }` with an `AgentCharter` that ships
**enabled by default** (`apps/server/src/sentinel` holds the default charters
and configs; packs ship domain-specific ones). Its charter's
`wake.onEvents` subscribes it to the spine — run/action/connector events,
`workspace.status_changed`, and above all `conversation.message`. Its rule
set is **configuration** (charter prompt + pack-shipped config docs), editable
and versioned like any skill — there are no sentinel-specific core tables.

This was a deliberate demotion: an earlier design had RulePack/Flag framework
schemas. Watchers-as-agents means new watch concerns need zero schema changes,
rule sets evolve through the same propose→review lifecycle as skills, and the
watchers' own activity is visible on the spine like everyone else's.

## Findings use existing primitives

A watcher that finds something does what any agent does:

- **`HumanRequest{ kind: 'notification'|'question', subjectKind: 'watcher_finding' }`**
  routed to the responsible party, always with Evidence attached. Welfare
  findings are marked confidential in the payload.
- **A WorkItem** when remediation is actual work to track.

Nothing special-cased: findings show up in the same Inbox, with the same
evidence-first cards, riding the same delivery machinery.

## Model welfare via conversation.message

ALL human↔agent traffic — Slack loops, portal chat, email replies — is
ingested as quarantined Docs and emits `conversation.message
{ direction, channel, docId }` (see `packages/core/src/topics.ts`). That
gives welfare watchers a real data source: they read conversations off the
spine and can flag concerning interaction patterns (abusive exchanges, agents
expressing distress, coercive prompting) as confidential
`watcher_finding` requests. Welfare monitoring is default-on because it is
just another shipped charter.

## The default set

The skeleton ships charter/config data for four default watchers:

| Watcher | Watches | Typical finding |
|---------|---------|-----------------|
| compliance | actions, SoR writes, process events | regulated communication sent without required disclosure |
| welfare | `conversation.message` | concerning human↔agent interaction patterns (confidential) |
| security | custody issuance, browser actions, workspace events | credential use outside expected scope |
| data-quality | ingest + distill events | feeds landing malformed, entity attrs drifting from SchemaPack |

The default configs are authored data in `apps/server/src/sentinel` (packs in
`extensions/packs/*` ship domain-specific ones); the engines that run them
(AgentHost, executor) are the same ones every agent uses.
