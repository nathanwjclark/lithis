# @lithis/connector-linkedin

Browser-session LinkedIn connector: Sales Navigator search-result and profile
ingestion, plus connect/message actions. There is no LinkedIn API here — the
connector drives a real headed Chrome in a `@lithis/browserhost` pod, using a
sealed custody `browser_session` profile, timing-only humanization, and
CAPTCHA = pause + notify (never auto-solve).

## Degree guards (read this before touching anything)

**Everything ingested through this connector is degree 2.** Sales Navigator
search cards and prospect profiles describe people the tenant does *not* have a
relationship with yet. The rules, inherited from the CRM's `isInNetwork`
segregation and enforced query-side at `ContextStore.search`:

1. Every person/company entity written by this connector's feeds MUST carry
   `degree: 2`. No exceptions — even when a scraped card shows mutual
   connections.
2. Degree-2 entities **never surface in network-audience queries**.
   `ContextStore.search` defaults to `audience: 'network'`; prospect data is
   only reachable with an explicit `audience: 'prospecting'` (or `'all'`), and
   capabilities tagged `network_only` are pre-filtered by the ToolBroker. A
   weekly report about "my network" can never quietly include scraped
   prospects.
3. Promotion from degree 2 → degree 1 is a deliberate, evidenced act (an
   accepted connection, a real conversation) — never a side effect of ingest
   or entity resolution.
4. Outreach actions (`connect`, `message`) execute only against approved
   `ActionIntent` batches; the capabilities `browser.linkedin.connect` /
   `browser.linkedin.message` are the choke points the ToolBroker checks.

## Feeds

- `salesnav-search` — Sales Navigator search-result pages, captured per query;
  cards become degree-2 person entities with mutual-count/path hints.
- `profile` — individual prospect profile pages (page capture + extracted
  fields), degree 2.

## Actions

- `connect` (`browser.linkedin.connect`) — send a connection request with an
  optional note.
- `message` (`browser.linkedin.message`) — message an existing connection or
  InMail per plan limits.

Both produce `page_capture` Evidence and an ActionReceipt.
