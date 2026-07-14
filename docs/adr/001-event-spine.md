# ADR-001: One event spine, Postgres transactional outbox

## Status

Accepted (2026-07-14).

## Context

lithis needs an audit trail (regulated domains), a trigger bus (WatchRules,
agent wakes), a watcher surface (sentinel), a cost ledger, and an eval-replay
substrate. Building these as separate mechanisms multiplies write paths and
guarantees they drift. We also need event delivery without making a message
broker a hard dependency of a ten-minute local demo.

## Decision

ONE append-only event log serves all five roles. Every mutation writes its
`Event` rows **in the same Postgres transaction** as the state change (the
transactional outbox); a dispatcher (orchestrator role) delivers to durable,
cursor-checkpointed, at-least-once subscriptions. Topics are dot-namespaced
and registered via `defineEventType()` in `@lithis/core` — emitting an
unregistered topic is a bug. Locally delivery rides LISTEN/NOTIFY; on GCP a
`SpineDriver` adapter maps to Pub/Sub. Envelope fields `prevHash`/`hash`
reserve a tamper-evident chain (chaining itself deferred, TODOS.md).

External brokers (Kafka, Pub/Sub) as the PRIMARY log were rejected: the
outbox gives exactly-once-with-state writes for free, and `docker compose up`
stays a two-container data plane.

## Consequences

- Auditability is structural: if it happened, it's on the spine.
- Subscribers must be idempotent (at-least-once delivery).
- The events table becomes the hottest table; per-tenant `seq` and cursoring
  are designed for that, but partitioning/archival will eventually be needed.
- Replay-based evals fall out of the design instead of being built later.
- Cloud portability is confined to the `SpineDriver` adapter — no cloud SDK
  imports outside `deploy/`.
