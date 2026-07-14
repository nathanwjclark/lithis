# Quickstart

Ten minutes from clone to a running (and honestly-labeled) lithis stack.

## What lithis is right now

lithis is a **skeleton growing real organs** (see `docs/phases.md` for the
build-out tracker): the data model, event topics, state machines, and service
interfaces are real and tested; the event spine (transactional outbox +
dispatcher + clock), migrations, and iam identity are implemented; the
remaining services are declared stubs that **fail loudly** when invoked.
Nothing pretends to work. Every unimplemented path is registered through
`@lithis/stubkit`, throws `NotImplementedError` on use, and is enumerable at
runtime — so you always know exactly what is real.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.x
- Docker (for the compose stack)

## 1. Install and check (~2 min)

```bash
git clone https://github.com/nathanwjclark/lithis
cd lithis
bun install
bun run check     # typecheck + tests + stubscan + lint — all green
```

`bun run check` is the same gate CI runs. The `stubscan` step prints the
**stub census**: every registered stub id and its reason string. Reasons all
start with `LITHIS-STUB:`, so `grep -r "LITHIS-STUB:"` finds the same set in
source.

## 2. Bring up the stack (~3 min)

```bash
docker compose up
```

This starts four services:

| Service  | What                          | Where                  |
|----------|-------------------------------|------------------------|
| postgres | Postgres 16 + pgvector        | localhost:5432         |
| minio    | Object storage (blobs)        | localhost:9000 / 9001  |
| server   | lithis server, `LITHIS_ROLE=all` | http://localhost:4400 |
| portal   | React admin portal            | http://localhost:4401  |

The server applies migrations on boot. To seed a dev tenant + principal (and
get ready-to-paste `x-lithis-tenant` / `x-lithis-principal` identity headers
for the API):

```bash
bun packages/cli/src/cli.ts init    # migrate + seed; idempotent
```

## 3. What you see

**The stub census on boot.** The server logs every registered stub as it
starts — the honest inventory of what will fail if exercised:

```
stubkit: N registered stub(s) — these paths FAIL when exercised:
  - server.context.store.search  (0x)  LITHIS-STUB: hybrid FTS+vector search not implemented
  ...
```

**`GET /stubs`.** The same census as JSON, live, with invocation counts:
`curl http://localhost:4400/stubs`.

**The portal's "What's real yet" panel.** Open http://localhost:4401 and find
the What's-real-yet panel — it renders the live `/stubs` registry so anyone
evaluating lithis sees implementation status without reading code.

## 4. Poke the edges (~5 min)

- Browse the portal nav: Home, Inbox, Work, Processes, People & Companies,
  Documents, Reports, Connections, Systems, Compliance, Workbench. The shells
  are real; panels backed by stubbed services say so.
- Call a stubbed endpoint and watch it fail *loudly and specifically* — a
  `NotImplementedError` naming its stub id, never a fake success or dummy data.
- Read the concepts: [architecture overview](concepts/architecture-overview.md)
  → [the spine](concepts/spine.md) → [the work graph](concepts/work-graph.md)
  → [the human gate](concepts/human-gate.md).

## Where to go next

- `docs/concepts/` — the architecture of record.
- `docs/adr/` — why the big decisions went the way they did.
- `docs/pillar-map.md` — the 12 product pillars → module map.
- `TODOS.md` — what was deliberately deferred (the policy layer, chiefly).
- `CONTRIBUTING.md` — branches + PRs; PRs carry a stub-delta section.
