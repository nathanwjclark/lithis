# The human gate

ONE primitive for every human-in-the-loop moment
([ADR-002](../adr/002-human-gate.md)). Agents do the work; humans see
**evidence-first cards** and render verdicts.

## The record

From `packages/core/src/humangate.ts`:

```
HumanRequest { kind: 'approval'|'question'|'notification',
               subjectKind /* CLOSED enum, zod payload pinned per kind */,
               subjectRef, payload, evidenceIds[], summary, options?,
               routing: { assignee: Ref|role, channelPrefs, slaHours?,
                          escalationPath[], followUpCount, nextFollowUpAt? },
               state, resolution?, requestedBy }
```

## Where it is used (the closed list)

`subjectKind` is a **closed enum** — adding one is a deliberate schema
decision:

| subjectKind | Gates |
|-------------|-------|
| `node_result` | Gated process-node results (evidence + result for approval) |
| `action` | A single risky connector action |
| `action_batch` | ActionIntent batches — "approve 38 of 40 outreach actions, edit 2" with per-item verdicts |
| `cascade_plan` | Invalidation cascades over the width threshold |
| `skill_change` | Skill versions (payload carries capabilityDiff + eval result) |
| `template_change` | Artifact template changes |
| `sor_migration` | System-of-record schema migrations |
| `watcher_finding` | Sentinel watcher findings (welfare findings marked confidential in the payload) |
| `record_field` | Questions about a record; the resolution writes the answer back |

## States and transitions

`pending` is the only live state; every resolution verb is terminal, with one
exception — supersession (`HUMAN_REQUEST_TRANSITIONS` in core):

```
pending   → approved | denied | modified | answered | acknowledged | expired | superseded
approved  → superseded        // a cascade invalidated the thing that was approved
modified  → superseded
denied | answered | acknowledged | expired | superseded → (terminal)
```

When the Invalidator supersedes a granted request, the **original approvers
are notified** (`humangate.superseded`) — nobody's approval silently stops
meaning anything.

## Resolutions

```
resolution: { by, at, verdict, comment /* ALWAYS present — deny-comments have a home */,
              modification?, perItem?: [{ intentId, verdict, modification? }] }
```

Deny/modify on a `node_result` feeds straight back into the work graph: the
comment lands in a `WorkNote` and the next `RunBrief.reworkInput`, and the
node reruns with `trigger.cause: 'denial'|'modification'`.

`perItem` is what makes batches work: one request, one card, forty
ActionIntents, individual verdicts. This is the difference between autonomy
and approval fatigue.

## SLA is internal-only

`routing.slaHours`, follow-ups, and `escalationPath` apply to **internal
responders** — your underwriter who hasn't looked at the card. Chasing
EXTERNAL parties (a regulator, a carrier) is not a HumanRequest; it is a
[`WorkItem.followUp` cadence](work-graph.md) executed via approved connector
sends. The clock drives both, but they are different machines on purpose.

## Delivery

`delivery` renders requests as cards/digests/nudges and routes them to
Slack/Teams/email **via connectors' `act()`** (and the portal Inbox). Channel
preference lives in `routing.channelPrefs`; every send emits `delivery.sent`.

## Implemented in

Phase **P2-gate**: `apps/server/src/humangate/service.ts` (request/resolve/inbox
over Postgres, events on the transactional outbox) and `sla.ts` (the SLA
ladder run by the clock's `humangate.sla` TickSource — first breach follows up
with the current assignee, each further breach escalates along
`escalationPath`, an exhausted path expires the request; emitting
`humangate.follow_up` / `humangate.escalated` / `humangate.expired`).
Role-string assignees are tenant-visible in the inbox until role membership
lands with the policy layer. **Supersession is not implemented here** — it is
the Invalidator's move and lands with cascades in P8-process
(`humangate.superseded` is registered and waiting).
