# Contributing to lithis

## Workflow

- Branch off `main`, open a PR. No direct pushes to `main`.
- `bun run check` (typecheck + tests + stubscan + lint) must pass before review.
- Every PR description includes a **Stub delta** section: which stubs were
  added, implemented (removed), or renamed. `bun run stubscan --json stub-census.json`
  generates the census; CI attaches it to the PR.

## The stub convention (non-negotiable)

Unimplemented paths are declared with `stub()` / `stubValue()` / `stubService()`
from `@lithis/stubkit`, with a reason string starting `LITHIS-STUB:`. They throw
when exercised. Bare `throw new Error("TODO")`, silent empty returns, and inline
dummy data outside tests are CI failures. Fixture/mock data **inside tests** is
encouraged.

## Code conventions

- Bun workspaces; TypeScript strict; zod schemas in `packages/core` are the
  single source of truth for record shapes (`z.infer` the types, don't
  hand-write them).
- `apps/server` modules: public interface via `index.ts` only; per-module
  `migrations/`; no cross-module table access.
- Event topics registered via `defineEventType()`; no ad-hoc topic strings.
- No cloud SDK imports outside `deploy/`.

## Tests

`bun test` runs everything. Schema changes need round-trip tests; state-machine
changes need transition-table tests; stubbed services need an
`expectStub`-style test proving they fail loudly.
