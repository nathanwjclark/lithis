# Generated systems-of-record

Companies need real databases — an AMS for a brokerage, a pipeline tracker for
BD — not another spreadsheet export. The `sor` module turns declarative
descriptors into real Postgres tables ("Systems" in the portal), tightly
linked to the context store.

## Descriptors

From `packages/core/src/sor.ts`:

```
SorDescriptor { slug /* 'ams' */, displayName, version,
                tables: [{ name, description,
                           columns: [{ name /* snake_case, no leading _ */,
                                       type: text|integer|numeric|boolean|date|timestamptz|jsonb,
                                       nullable, description?, entityBinding? }] }],
                ddlBlobId?, migrations: [{ version, sqlBlobId, appliedBy: 'agent'|'human',
                                           approvalRequestId, appliedAt? }] }
```

Descriptors are data — packs ship them (`extensions/packs/insurance-brokerage`
ships the AMS descriptor), agents can draft them, and the schemas validate
today even though the runtime is stubbed.

## The structural columns

Generated tables live in `sor_{tenant}_{slug}` Postgres schemas (the tenant
ULID lowercased; a slug that would overflow Postgres' 63-byte identifier limit
is rejected, never truncated). Every table gets a reserved `_id` primary key
plus two reserved columns (underscore-prefixed names are reserved for lithis;
user columns can't start with `_`):

- **`_entityRef`** — the CRM-style tight link back to a context entity
  (`entityBinding` declares which column binds to which entity type, e.g.
  `client_name → person`). Rows and the knowledge graph stay joined.
- **`_origin`** — the standard `Origin` provenance shape: who/what wrote the
  row, how, in which session. Structural provenance, **no fact-grading
  columns** ([ADR-005](../adr/005-origin-not-epistemology.md)).

## Gated migrations

Schema changes to a live system-of-record are exactly the kind of thing an
autonomous agent must not do silently:

1. `SorRuntime.propose(draft, p)` → `sor.migration.proposed` +
   `HumanRequest{subjectKind:'sor_migration'}` (the DDL is in the payload,
   rendered for review, and stored as a blob so the card cites immutable bytes).
2. On approval, `apply(descriptorId, p)` runs the migration **in one
   transaction with its audit write** and records
   `{ version, sqlBlobId, appliedBy: 'agent'|'human', approvalRequestId,
   appliedAt }` — the audit trail is in the descriptor itself, and
   `sor.migration.applied` lands on the spine.

The descriptor's `tables` are what it **declares**; the runtime separately
tracks what has actually been **applied**, and diffs proposals against the
applied set — a denied or still-pending proposal can never be mistaken for live
schema.

**v1 is additive only.** New tables and new *nullable* columns apply; dropping
a table or column, changing a column's type, tightening nullability, and adding
a NOT NULL column to a populated table are rejected with an explicit list of
the offending changes. They need a data-migration plan and their own gate.

Descriptors are DATA — packs ship them, agents draft them — so every
descriptor-supplied identifier is treated as hostile input: re-validated
against a strict `^[a-z][a-z0-9_]*$` regex at DDL time and always quoted, with
descriptor prose escaped as a SQL literal.

## Access

No raw SQL surface. `SorRuntime.table(system, name, p)` returns a scoped,
tenant-schema-bound table handle — the `PrincipalContext` is an explicit
parameter, because tenancy and provenance are caller facts, not ambient state.
Every identifier the handle emits comes from the *applied* descriptor and is
quoted; every value is a bound parameter; unknown columns and reserved names
throw, and an empty `where` on `update` is refused rather than rewriting the
table. Writes stamp `_origin`, and `_entityRef` when the caller supplies it
(resolving an `entityBinding` value to an entity id automatically needs an
exact context lookup surface that does not exist yet — a registered stub, not
a guess). Externally-visible SoR writes ride the same ActionIntent /
HumanRequest gating as any other risky action.
