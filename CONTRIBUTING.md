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

## Parallel phase development

Build-out phases (see [docs/phases.md](docs/phases.md) for the DAG and status
tracker) are developed concurrently in git worktrees, one PR per phase.

- **Worktrees**: `git worktree add ../lithis-worktrees/<codename> -b phase/<codename> origin/main`.
  Branch names: `phase/<codename>` (e.g. `phase/p2-gate`, `phase/c-slack`);
  dependency chores: `chore/deps-<pkg>`. Run `bun install` per worktree (fast —
  Bun's global cache); never symlink `node_modules`. Rebase onto `main` after
  every merge in your wave.
- **bun.lock policy**: new runtime dependencies never land inside a phase PR.
  Open a two-file `chore/deps-<pkg>` PR (package.json + bun.lock) against
  `main` first, merge it same-day, rebase. Prefer built-ins (Bun SQL, Bun.s3,
  `fetch`) so the lockfile stays quiet.
- **Postgres**: one shared instance (`docker compose up -d postgres minio` in
  the main checkout); per-worktree databases via an uncommitted `.env.local`:
  `DATABASE_URL=postgres://lithis:lithis-local@localhost:5432/lithis_<codename>`
  and `PORT=4400+offset` (portal `4500+offset`). Integration tests use
  `LITHIS_TEST_DATABASE_URL` (a *separate* `lithis_test_<codename>` database —
  the harness truncates tables and auto-creates missing databases).
- **Shared-file etiquette** (these seams exist so parallel branches never
  conflict — stay inside yours):
  - new event topics → your domain's `packages/core/src/topics/<domain>.ts` only;
  - new HTTP routes → your module's `apps/server/src/api/routes/<module>.ts`;
  - stub-assertion tests → your module's `apps/server/test/modules/<module>.test.ts`
    (delete cases you implement, add real behavioral tests);
  - `apps/server/src/main.ts` → one line in the services literal;
  - env vars are pre-declared as optional keys in `apps/server/src/config.ts` —
    if yours is missing, add it as optional, never required.

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
