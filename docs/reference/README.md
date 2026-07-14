# API reference

**Generated, not written.** The zod schemas in `@lithis/core`
(`packages/core/src/*.ts`) are the single source of truth for every record
shape, enum, transition table, and event payload in lithis — all TypeScript
types are `z.infer`'d from them, and nothing hand-duplicates a record shape.

The reference docs for this directory are meant to be **generated from those
schemas** (zod → JSON Schema → markdown pages, plus the event-topic catalog
from the `defineEventType()` registry). That tooling does not exist yet; when
it lands it will live in `tooling/` and run as part of the docs build.

Until then, the schemas themselves are the reference — they are short,
commented, and organized by domain:

| File | Contents |
|------|----------|
| `refs.ts` | `Ref`, the closed `RefKind` enum |
| `origin.ts` | `Origin` (provenance + trust), trust levels |
| `session.ts` | `Session` |
| `iam.ts` | Tenant, Principal, AgentCharter, ActionIntent, PrincipalContext, PolicyDecision |
| `context.ts` | Blob, Doc, Entity, Link, Chunk, SchemaPack, RelationshipScore, audience |
| `work.ts` | WorkItem (+ the transition table), WorkEdge, WorkNote |
| `process.ts` | ProcessTemplate, NodeDef, ProcessRun, WatchRule, InvalidationCause, CascadePlan |
| `runs.ts` | Run, RunResult, Evidence, RunBrief, RunOutcome |
| `humangate.ts` | HumanRequest (+ the transition table), routing, resolution |
| `events.ts` / `topics.ts` | Event envelope, `defineEventType()`, the topic catalog |
| `connectivity.ts` | Connection, FeedExpectation, Credential |
| `skills.ts` | Skill, SkillVersion, SkillManifest, ReportDefinition |
| `artifacts.ts` | Template, Artifact |
| `sor.ts` | SorDescriptor, SorTable, migrations |
| `workspace.ts` | Workspace |
