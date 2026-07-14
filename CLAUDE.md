# lithis — agent instructions

Open-source AI tools for companies. TypeScript-first Bun-workspace monorepo. The
architecture of record lives in `docs/` (start with `docs/concepts/`); deferred
projects live in `TODOS.md`.

## Hard rules

### 1. Stubs are loud, registered, and searchable — NEVER silent

The top project risk is placeholder code or data silently passing as real. Every
unimplemented path MUST be declared via `@lithis/stubkit`:

```ts
import { stub, stubService } from "@lithis/stubkit";

export const search = stub<ContextStore["search"]>(
  "server.context.store.search",
  "LITHIS-STUB: hybrid FTS+vector search not implemented",
);
```

- The reason string MUST start with `LITHIS-STUB:` (stubkit enforces this at
  registration; `bun run stubscan` enforces it statically in CI).
- Stub ids are dot-namespaced and unique repo-wide: `<app|pkg>.<module>.<thing>`.
- NEVER: `throw new Error("TODO...")`, hand-made `NotImplementedError`, empty
  returns pretending to succeed, or inline dummy data outside `test/`/`fixtures/`.
- Mock/fixture data is welcome IN TESTS — that is exactly where it belongs.
- Run `bun run stubscan` before committing; it fails on violations and prints the
  stub census.

### 2. Module boundaries

`apps/server/src/<module>/` directories expose their interface via `index.ts`
only. Cross-module imports of anything deeper are an ESLint error
(`lithis/server-module-boundaries`). Each module owns its own `migrations/`
directory and its own tables — no cross-module table access.

### 3. Tests run green before you stop

`bun run check` = typecheck + tests + stubscan + lint. All four must pass.
New pure logic gets unit tests with fixture data. Stubbed services get a test
asserting they throw `NotImplementedError` (use `expectStub` from `@lithis/evals`).

### 4. Branches + PRs

Never commit directly to `main`. Work on a branch, open a PR.

## Layout

- `packages/core` — every record zod schema, Ref/RefKind, Origin, event registry. Schema changes happen HERE, nowhere else.
- `packages/stubkit` — the stub machinery (always fully implemented — never stub the stubkit).
- `packages/sdk` / `cli` / `evals` — client + authoring kits / `lithis` CLI / eval contracts.
- `apps/server` — modular monolith (role flags api|orchestrator|worker|all): spine, iam, custody, context, work, processes, humangate, agents, connections, delivery, skills, artifacts, sor, sentinel, api.
- `apps/portal` / `workbench` / `browserhost` — React admin portal / cloud dev env / browser session pods.
- `extensions/` — connectors, skills, packs (the three plugin surfaces).
- `tooling/` — tsconfig, eslint-config (custom rules), stubscan.

## Conventions

- Bun for everything: `bun install`, `bun test`, `bun run typecheck`.
- Zod schemas are the source of truth for types (`z.infer`); no hand-duplicated interfaces for record shapes.
- All ids are ULIDs via `@lithis/core` `newUlid()`.
- Every record carries `tenantId`; provenance is the shared `Origin` shape (`by/method/trust/sessionId/at`). No epistemology/fact-grading fields — context stores information, review states live on WorkItem/HumanRequest only.
- Event topics are dot-namespaced and registered via `defineEventType()` in `packages/core` — emitting an unregistered topic is a bug.
- No cloud SDK imports outside `deploy/` adapters.
