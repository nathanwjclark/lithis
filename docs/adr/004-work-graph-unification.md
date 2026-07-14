# ADR-004: Process nodes ARE work items (one work graph)

## Status

Accepted (2026-07-14).

## Context

The design had two pillars that looked separate: process orchestration
(templated, gated, invalidatable node graphs) and a global agent task list
(oneoffs, recurring schedules, continuous responsibilities, follow-up
cadences). Two tables means two state machines, two claim protocols, two lease
implementations, and an awkward bridge whenever a process node needs task-list
behavior (priority, notes, leases) or a task needs process behavior
(dependencies, gates).

## Decision

ONE `WorkItem` table with `kind: oneoff|recurring|continuous|process_node`.
Process instantiation mints WorkItems + `WorkEdge{depends_on|subtask_of}`
rows; node state lives on the WorkItem — there is no second state machine.
One transition table (`WORK_ITEM_TRANSITIONS`, exhaustively tested), one
lease/claim protocol (`FOR UPDATE SKIP LOCKED` + heartbeat — the WorkItem
table IS the job queue, no external broker), one append-only `WorkNote`
journal, one clock waking everything time-based.

`depends_on` is ENFORCED (pending→ready requires upstreams done), and the
Invalidator is the only writer of `stale`.

## Consequences

- Agents claim underwriting nodes and BD follow-ups through the same
  interface; the portal Work view is one query.
- The invalidation cascade (done→stale) applies uniformly to anything with
  dependencies, not just "process" work.
- The WorkItem schema carries optional fields for every kind (schedule,
  followUp, processRunId/nodeKey, lease) — a deliberately wide record instead
  of a join zoo.
- Queue throughput is bounded by Postgres row locking; fine for the target
  scale, revisit before thousands of concurrent workers.
