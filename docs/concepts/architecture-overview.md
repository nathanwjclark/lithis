# Architecture overview

lithis is open-source AI tooling for companies where agents are **autonomous
operators, not assistants**: long-lived resident agents work a continuous task
list, proactively reach out to humans, and present their work as
evidence + result for approval.

## Design principles

1. **Every agent effect leaves evidence on the spine.** No connector action,
   SoR write, or self-modification without a spine event and evidence.
2. **Code for data, LLMs for judgment** — and every LLM judgment is an
   auditable event.
3. **One spine.** The append-only event log is simultaneously audit trail,
   trigger bus, watcher surface, cost ledger, and eval-replay substrate.
4. **One work graph.** Process node-runs ARE work items — one table, one state
   machine, one claim protocol.
5. **One human primitive.** `HumanRequest` with evidence-first cards, routing,
   SLA, escalation — reused everywhere a person is needed.
6. **Agents are residents, not invocations.** openclaw-style daemons with
   durable memory and heartbeat/event/message wakes; every piece of work
   traces to a `Session`.
7. **Untrusted content is data, never instructions.** `origin.trust` and doc
   quarantine are schema properties; fencing is enforced at brief assembly.
8. **Guards are choke points, not fields.** Degree filtering and tool scoping
   live at single interfaces (`ContextStore.search`, `ToolBroker`).
9. **Adoption engineering.** Four containers, one server binary with role
   flags, three extension points, a ten-minute demo.
10. **Git for definitions, Postgres for state.** Skills/templates/packs are
    authored via branches + PRs; runtime state, approvals, and events live in
    rows.
11. **Structural honesty.** `stub()` + runtime registry + CI census + the
    portal "What's real yet" panel.

## The four hubs

Everything routes through four shared mechanisms:

### The spine (`apps/server/src/spine`)
Append-only, per-tenant-sequenced events written via a transactional outbox —
every mutation commits its event rows in the same transaction. Topics are
dot-namespaced and registered with `defineEventType()` in `@lithis/core`;
emitting an unregistered topic is a bug. See [spine](spine.md).

### The work graph (`apps/server/src/work`)
ONE `WorkItem` table serves the global agent task list AND process
orchestration nodes (`kind: 'process_node'`). One state machine, one lease
protocol (`FOR UPDATE SKIP LOCKED`), one journal (`WorkNote`). See
[work graph](work-graph.md).

### The human gate (`apps/server/src/humangate`)
ONE `HumanRequest` primitive (approval | question | notification) with a
closed `subjectKind` enum covering node results, action batches, cascade
plans, skill/template changes, SoR migrations, watcher findings, and
record-field questions. See [human gate](human-gate.md).

### Sessions (`packages/core` + `apps/server/src/agents`)
Every agent wake, chat thread, executor run, and workbench stint happens
inside a first-class `Session`; anything created carries `origin.sessionId`.
Provenance everywhere is the single `Origin` shape:
`{ by, method: code|llm|human|external, trust: internal|partner|untrusted, sessionId?, at }`.

## Domains

The server is a **modular monolith** with role flags
(`LITHIS_ROLE=api|orchestrator|worker|all`). Modules expose their interface
via `index.ts` only (lint-enforced) and own their tables + migrations:

`spine` · `iam` · `custody` · `context` · `work` · `processes` · `humangate` ·
`agents` · `connections` · `delivery` · `skills` · `artifacts` · `sor` ·
`sentinel` · `api`

Around it: `apps/portal` (React admin), `apps/workbench` (cloud dev env,
PR-only egress), `apps/browserhost` (headed-Chrome session pods), and
`extensions/` (connectors, skills, packs — the three plugin surfaces).

## Types come from one place

`@lithis/core` holds every record zod schema; all types are `z.infer`'d.
Universal pointer: `Ref { kind: RefKind, id: Ulid }` with a **closed**
`RefKind` enum. All ids are ULIDs; every record carries `tenantId`.

## What is deliberately NOT here

- **No epistemology / fact-grading** in the context store — context stores
  information; review states live on WorkItem/HumanRequest only
  ([ADR-005](../adr/005-origin-not-epistemology.md)).
- **The policy/permissioning layer is deferred** — `PolicyEngine` ships as an
  unwired stub; Grant/Mandate live in `TODOS.md`
  ([ADR-006](../adr/006-policy-layer-deferred.md)).
- **No cloud SDK imports outside `deploy/`** — the core is
  deployment-agnostic; GCP specifics live in `deploy/gcp/`.
