# The event spine

One append-only event log is simultaneously the audit trail, the trigger bus,
the watcher surface, the cost ledger, and the eval-replay substrate
([ADR-001](../adr/001-event-spine.md)).

## The envelope

Every event is the `Event` shape from `packages/core/src/events.ts`:

```
Event { id: ulid, tenantId, seq: bigint /* per-tenant, outbox-assigned */,
        topic, subjectRefs: Ref[], payload, actor: Ref,
        causationId?, correlationId?, severity?, at, prevHash?, hash? }
```

`prevHash`/`hash` model an optional tamper-evident chain; actual chaining is
deferred (`TODOS.md`).

## Topics are registered, never ad-hoc

Topics are dot-namespaced and MUST be registered via `defineEventType()` —
emitting an unregistered topic is a bug (`validateEventPayload` throws). The
catalog lives in `packages/core/src/topics.ts`:

| Area | Topics |
|------|--------|
| sessions | `session.started` · `session.ended` |
| context | `context.blob.created` · `context.doc.created` · `context.doc.distilled` · `context.entity.created` · `context.link.created` |
| work | `work.item.opened` · `work.item.status_changed` · `work.note.added` |
| processes | `process.run.instantiated` · `process.cascade.planned` · `process.cascade.executed` |
| humangate | `humangate.requested` · `humangate.resolved` · `humangate.superseded` |
| runs | `run.started` · `run.finished` |
| conversations | `conversation.message` |
| connectivity | `connector.sync.completed` · `connection.health.changed` · `feed.expectation.missed` |
| skills / artifacts / sor | `skill.version.proposed` · `skill.version.activated` · `artifact.rendered` · `artifact.verified` · `sor.migration.proposed` · `sor.migration.applied` |
| delivery / workspace | `delivery.sent` · `workspace.status_changed` |
| agents | `agent.woke` · `agent.slept` |

Payloads stay lean: the envelope's `subjectRefs` carry identity; payloads
carry only what subscribers need without a fetch.

## The outbox

State lives in Postgres (schema-per-module, row-level tenancy). Every mutation
writes its Event rows **in the same transaction** — the transactional outbox.
The dispatcher (orchestrator role) delivers events to durable,
cursor-checkpointed, at-least-once subscriptions. Locally it rides
LISTEN/NOTIFY; on GCP a `SpineDriver` adapter maps to Pub/Sub (the adapter is
the only place that knows — no cloud SDK imports outside `deploy/`).

The interface (`EventSpine`, stubbed in `apps/server/src/spine`):

```ts
append(tx: DbTx, e: NewEvent): Promise<Event>;        // transactional outbox
subscribe(consumerId, sel: EventSelector, h): Subscription;
readSince(cursor, sel?, limit?): Promise<Event[]>;
```

## The clock

ONE loop (orchestrator role) is the single tick source for everything
time-based:

- recurring `WorkItem.schedule` crons (mints oneoff occurrence children),
- `followUp.nextAt` wakes (external-party cadences),
- `FeedExpectation` grace windows (missed feeds → `feed.expectation.missed`),
- `HumanRequest` SLA follow-ups and escalations (internal responders only).

On GCP, a Cloud Scheduler job exists purely as a backstop for split-role
topologies (see `deploy/gcp/80-schedulers.sh`); with `LITHIS_ROLE=all` or
`orchestrator` the clock is in-process.

## Conversations ride the spine too

ALL inbound human↔agent traffic (Slack loops, portal chat, email replies) is
ingested as quarantined Docs and emits `conversation.message` — which is how
[sentinel welfare watchers](sentinel-watchers.md) get a real data source
rather than a bolted-on hook.
