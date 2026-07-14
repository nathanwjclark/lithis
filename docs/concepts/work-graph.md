# The work graph

Pillars "process orchestration" and "global task list" are ONE table
([ADR-004](../adr/004-work-graph-unification.md)). A `WorkItem` is an agent's
todo, a recurring schedule, a continuous responsibility, or a process node —
same state machine, same claim protocol, same journal.

## The record

From `packages/core/src/work.ts`:

```
WorkItem { kind: 'oneoff'|'recurring'|'continuous'|'process_node',
           title, body, status, ownerPrincipalId, priority, dueAt?, wakeAt?,
           schedule?: Cron,                      // recurring: clock mints oneoff children
           followUp?: { counterpartRef /* Entity, NOT a Principal */, cadence,
                        nextAt, lastContactAt?, escalateAfterDays?, escalateToPrincipalId? },
           processRunId?, nodeKey?,              // set when kind = process_node
           attempt, lease?, sourceRefs: Ref[], revision }
WorkEdge { fromId, toId, verb: 'depends_on'|'subtask_of' }
WorkNote { workItemId, at, byRef, kind: 'status'|'human'|'system', text }   // append-only
```

## The state machine

The authoritative transition table is `WORK_ITEM_TRANSITIONS` in
`packages/core/src/work.ts`, tested exhaustively:

| from | allowed to |
|------|-----------|
| `pending` | `ready`, `cancelled` |
| `ready` | `claimed`, `pending`, `cancelled` |
| `claimed` | `running`, `ready`, `cancelled` |
| `running` | `done`, `awaiting_approval`, `blocked`, `failed`, `ready`, `cancelled` |
| `awaiting_approval` | `done`, `ready`, `stale`, `cancelled` |
| `blocked` | `ready`, `cancelled` |
| `failed` | `ready`, `cancelled` |
| `done` | `stale` |
| `stale` | `pending`, `ready`, `cancelled` |
| `cancelled` | — (terminal) |

Reading the edges:

- **pending → ready** when all `depends_on` upstreams are done (ENFORCED — the
  gap trellis had) or `wakeAt` fires.
- **ready → claimed → running**: a lease is acquired and a `Run` row created.
- **claimed|running → ready**: lease expired or released; `attempt` preserved.
- **running → awaiting_approval**: a gated node reported a `RunResult`; a
  `HumanRequest{subjectKind:'node_result'}` is minted.
- **awaiting_approval → ready**: deny/modify — the result is superseded, the
  reviewer's comment lands in a `WorkNote` and the next `RunBrief.reworkInput`,
  `attempt` increments, and the Invalidator runs at this node.
- **done → stale**: written ONLY by the Invalidator (invalidation cascade);
  `stale → pending|ready` per recomputed dependencies.
- **any non-terminal → cancelled**: human or orchestrator; an in-flight run is
  aborted via lease revocation → `AbortSignal`.

## The table IS the job queue

No external broker: workers claim `ready` items with
`FOR UPDATE SKIP LOCKED`, hold a lease
(`{ holderPrincipalId, runId, expiresAt, heartbeatAt }`), and heartbeat it.
Expired leases return items to `ready` with `attempt` intact. The `WorkQueue`
interface (implemented in `apps/server/src/work` as of P5-work):
`open · claim · heartbeat · release · complete · addNote`. The
`work.lease-reclaim` TickSource (registered on the clock) reclaims expired
leases and flips due `wakeAt` sleepers pending→ready; an expired lease is dead
for its holder even before the tick notices. Still stubbed/deferred:
recurring-schedule minting of oneoff children (clock cron work) and any
WorkEdge queue surface — the `work_edges` table ships, but pending→ready on
`depends_on` completion lands with P8-process.

## Follow-ups are not approvals

External-party cadences (a regulator who owes you an answer, a carrier who
owes a quote) live on `WorkItem.followUp` — the counterpart is an **Entity**,
the clock fires `nextAt`, and nudges go out through approved connector sends.
`HumanRequest` SLA machinery is for INTERNAL responders only
([ADR-002](../adr/002-human-gate.md)).

## Journal, not mutation

`WorkNote` is the append-only history of a work item (status notes, human
comments, system notes); each addition emits `work.note.added`. Status changes
emit `work.item.status_changed { from, to, attempt }`.
