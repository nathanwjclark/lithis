# Pillar map

Where each of the twelve product pillars lives, and what the synthesis
consolidated. (Post-amendment version — watchers are agents, policy layer
deferred, no epistemology.)

| # | Pillar | Home | Consolidation |
|---|--------|------|---------------|
| 1 | Unified context store | `apps/server/src/context` + `@lithis/core` context schemas | Association mining = ingest-time distill + query-time search over the deterministic index (FTS + pgvector); no fact-grading ([ADR-005](adr/005-origin-not-epistemology.md)) |
| 2 | Agent runtime, connectors, browser | `agents`, `connections`, `extensions/connectors`, `@lithis/sdk` connector/browser kits, `apps/browserhost` | Browser integrations implement the same `Connector` interface; sessions sealed in `custody` ([ADR-003](adr/003-custody-and-browserhost.md)) |
| 3 | Process orchestration | `processes` + `humangate` + Evidence | **Merged with 4**: node-runs ARE WorkItems; gates = HumanRequest; one Invalidator ([ADR-004](adr/004-work-graph-unification.md)) |
| 4 | Global task list | `work` | **Same table as 3**; follow-up cadence + WorkNotes; the clock wakes continuous items |
| 5 | Cloud Claude Code env | `apps/workbench` + the `Workspace` record | PR-only egress; workspace lifecycle emits events (sentinel-visible) |
| 6 | Skills + self-mod guardrails | `skills` + `iam` + `humangate` | selfModBounds + capabilityDiff + eval gate + `skill_change` HumanRequest; ToolBroker issues from charter + manifests (grant intersection deferred, [ADR-006](adr/006-policy-layer-deferred.md)) |
| 7 | Reporting + scheduling | **dissolved**: reports-as-skills + recurring WorkItems + `delivery` | `ReportDefinition` record kept for the portal Reports tab |
| 8 | Admin portal | `apps/portal` over the `api` module's tools | Every capability defined once, served to UI/chat/MCP; infra map = projection of Connections + Workspaces + SorDescriptors + the deploy manifest (`deploy/gcp/90-deploy-manifest.sh`) + the github connector |
| 9 | Doc/asset generation + verification | `artifacts` | Verification IS Evidence (kind `verification`); template changes gate via HumanRequest |
| 10 | Generated systems-of-record | `sor` (packs ship descriptors) | `_entityRef` + `_origin` columns = the CRM tight link + provenance; migrations approval-gated |
| 11 | Data-connectivity management | **merged into `connections`** | FeedExpectations + health are the ops face of pillar 2; misses → events → flags/WorkItems |
| 12 | Compliance + model welfare | `sentinel` default watcher agents | Watchers are ordinary agents (charters + configs), not framework schemas; findings = HumanRequests/WorkItems with Evidence |

## Cross-cutting pieces the pillars didn't name

Added during synthesis because every pillar needed them:

- **Identity & multi-tenancy** (`iam`) — minimal by design; the full policy
  layer is deferred ([ADR-006](adr/006-policy-layer-deferred.md)).
- **The event spine** ([ADR-001](adr/001-event-spine.md)).
- **ONE `HumanRequest`** ([ADR-002](adr/002-human-gate.md)) + ActionIntent
  batches (batch approvals — autonomy without approval fatigue).
- **`custody`** incl. sealed browser sessions.
- **First-class `Session` provenance** (`origin.sessionId` everywhere).
- **Per-run cost** with charter budgets; the spine as cost ledger.
- **`evals` harness** (`packages/evals`) — fixture briefs, event-log replay,
  connector conformance.
- **WorkNote journal**, **RelationshipScore + path ranking**, **conversation
  ingestion** (welfare watchers' data source), **FeedExpectation SLAs**,
  **`AgentHost` resident-agent loop**, **`Workspace` record**.
