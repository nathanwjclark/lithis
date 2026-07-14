# @lithis/pack-linkedin-bd

LinkedIn business-development expansion pack: the Sales Navigator selector
pack the linkedin connector scrapes with, plus the charter for the resident BD
agent that runs the pipeline (nightly sweeps → degree-2 ingestion →
path-ranked outreach batches).

## Selector pack status

`salesNavCardSelectors` is a **typed stub** (`packs.linkedin-bd.selectors`).
The actual CSS selectors live in the private CRM's scraper
(`crm/scraper/extract-cards.ts`) and migrate here when that service migrates.
Until then, any property access throws `NotImplementedError` — selector values
can never silently flow as placeholder data.

## Degree-guard rules (non-negotiable)

Prospect data is radioactive to the network graph. Inherited from the CRM's
`isInNetwork` segregation, enforced query-side at `ContextStore.search` and at
the ToolBroker:

1. **Everything this pack ingests is degree 2.** Every person/company entity
   created from Sales Navigator sweeps or prospect profiles carries
   `degree: 2`, no exceptions.
2. **Degree 2 never surfaces in network-audience queries.** Searches default
   to `audience: 'network'`; prospects are only reachable via an explicit
   `'prospecting'`/`'all'` audience, and `network_only`-tagged capabilities are
   pre-filtered by the ToolBroker. Weekly reports, relationship scores, and
   "who do we know at X" answers never quietly include scraped prospects.
3. **Promotion 2 → 1 is a deliberate, evidenced act** — an accepted
   connection or a genuine conversation, recorded with origin/session
   provenance. Never a side effect of ingest, entity resolution, or an agent
   "tidying up".
4. **No contact without an approved batch.** Outreach happens only through
   `ActionIntent` batches resolved by a human (per-item verdicts). The BD
   agent proposes; it never sends on its own authority.
5. **Path ranking reads the network, but writes nothing to it.** Ranking
   prospects by mutual-connection paths (`RelationshipGraph.paths`) may read
   degree-1 data; it must never create links from network people to prospects
   except the explicit `mutual_connection` hints carried on the degree-2 side.
