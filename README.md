# Lithis

**Open-source AI tools for companies** — a unified context store, resident autonomous agents, heavy-duty process orchestration with human approval gates, and the operational scaffolding (connectors, skills, reporting, compliance watching, an admin portal) that makes autonomous agents deployable at real companies. Flagship domains: insurance brokerage/underwriting and LinkedIn business development.

> **Status: skeleton.** The data model, interfaces, and module layout are real and compile; most service implementations are loud, registered stubs (see below). Build-out is phased — each phase lands an independently useful slice.

## What's inside

| Area | What it is |
|---|---|
| **Context** | Blobs + docs + entities + typed links over Postgres/pgvector + object storage. Ingest, don't curate: deterministic index at ingest, association discovery at search time. |
| **Work** | ONE work graph: the global agent task list and process-orchestration nodes are the same table, with enforced dependencies, leases, and follow-up cadences. |
| **Processes** | Authored process templates (fixed / adaptive / dynamic) → runs whose gated nodes produce **evidence + result** for human approval; denials and new information trigger a deterministic invalidation cascade. |
| **Agents** | Resident daemons (openclaw-style), not invoked workers: charter + durable memory + heartbeat/event/message wakes, executing via the Claude Agent SDK. |
| **Human gate** | One primitive — `HumanRequest` (approval / question / notification) with evidence-first cards, routing, SLAs, escalation. |
| **Connectors** | Google Workspace, Microsoft 365, Slack, GitHub, file drops (SFTP/S3), LinkedIn browser automation — one `Connector` interface with health + expected-feed SLAs. |
| **Skills & packs** | Git-authoritative skills with a guarded self-modification lifecycle; domain packs (insurance-brokerage, linkedin-bd) ship process templates, SoR descriptors, and watcher-agent configs as data. |
| **Portal** | React admin app a nontechnical operator understands: Inbox, Work, Processes, People & Companies, Connections, Systems, Compliance — plus "What's real yet". |

## Honesty machinery

Greenfield AI-built codebases rot silently through mocked data and stubbed
functions that pretend to work. Lithis makes that structurally impossible:

- every placeholder is `stub()` from [`@lithis/stubkit`](packages/stubkit) — it **throws** when exercised and registers in an enumerable census;
- every stub is greppable: `grep -r "LITHIS-STUB:"`;
- CI runs [`stubscan`](tooling/stubscan), which fails on unregistered placeholders and publishes the census;
- the portal renders the census as a "What's real yet" panel.

## Quickstart

```bash
bun install
bun run check          # typecheck + tests + stubscan + lint
docker compose up      # postgres+pgvector, minio, server, portal
```

See [`docs/quickstart.md`](docs/quickstart.md) for the guided tour and
[`docs/`](docs/) for concepts and ADRs. Deferred workstreams: [`TODOS.md`](TODOS.md).

## License

Apache-2.0
