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

Generated tables live in `sor_{tenant}_{slug}` Postgres schemas. Every table
gets two reserved columns (underscore-prefixed names are reserved for lithis;
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

1. `SorRuntime.propose(draft)` → `sor.migration.proposed` +
   `HumanRequest{subjectKind:'sor_migration'}` (the DDL is in the payload,
   rendered for review).
2. On approval, `apply(descriptorId)` runs the migration and records
   `{ version, sqlBlobId, appliedBy: 'agent'|'human', approvalRequestId,
   appliedAt }` — the audit trail is in the descriptor itself, and
   `sor.migration.applied` lands on the spine.

## Access

No raw SQL surface. `SorRuntime.table(system, name)` returns a scoped,
tenant-schema-bound table handle; writes stamp `_origin` and (where bound)
`_entityRef`. Externally-visible SoR writes ride the same ActionIntent /
HumanRequest gating as any other risky action.
