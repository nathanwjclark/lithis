# Connectivity

One connector registry is both the integration surface (pillar 2) and the ops
face (pillar 11): the same `connections` module tracks what's plugged in, how
healthy it is, and whether expected data actually arrived.

## Connectors

A connector (`extensions/connectors/*`, authored against
`@lithis/sdk/connectors`) implements:

```ts
interface Connector {
  manifest: ConnectorManifest;   // slug, authKind, feeds, actions, scopes
  sync(c, feed, cursor, sink): Promise<Cursor>;   // idempotent, dry-runnable
  act(c, action, auth: BrokeredAuth): Promise<ActionReceipt>;
  health(c): Promise<ConnectionHealth>;
}
```

- **`sync` is code, not LLM** — deterministic, idempotent, cursor-driven,
  dry-run-first (the CRM collector lesson). Synced content lands as
  blobs + quarantined docs with `origin.trust` set (`partner` for a carrier
  SFTP, `untrusted` for scraped web).
- **`act` is how anything leaves the building** — emails, Slack cards,
  LinkedIn connects, portal uploads. Risky actions gate as
  `HumanRequest{action|action_batch}` upstream; every act emits events and
  returns a receipt.
- Browser-based integrations (LinkedIn, carrier portals) implement the SAME
  interface — the browser is a transport, not a different concept.

## Connections, health, expectations

From `packages/core/src/connectivity.ts`:

```
Connection { connectorSlug, displayName, credentialRef, scopes[],
             status: 'healthy'|'degraded'|'expired'|'disabled',
             health: { lastOkAt?, lastError? },
             syncState: { cursorsByFeed, lastSyncAt?, lastError? } }
FeedExpectation { connectionId, key /* "carrier-sftp:loss-runs" */,
                  expectCadence: Cron, graceMinutes, lastSeenAt?, missedCount,
                  onMiss: 'flag'|'task'|'both' }
```

`FeedExpectation` is the "the loss-runs feed goes quiet for two weeks and
nobody notices" defense: the clock checks grace windows and emits
`feed.expectation.missed`, which becomes a flag and/or a WorkItem per
`onMiss`. Health transitions emit `connection.health.changed`; syncs emit
`connector.sync.completed`.

> **Implemented in P3-connect**: the Postgres connection registry (register /
> list / health / recordFeedSeen), the `ConnectorRuntime` seam connectors
> register into (plain `Connector` or a factory receiving the
> `ConnectorAuthProvider`), and two clock TickSources —
> `connections.feed-expectations` (misses announce once per missed cron
> occurrence, recover via `recordFeedSeen`, recovery emits
> `feed.expectation.recovered`) and `connections.sync` (due connections pull
> every manifest feed from its stored cursor; failures land honestly in
> `syncState.lastError` + health). Synced content still flows into a stubbed
> ingest sink until P4-context lands.

## Custody

Agents never see raw secrets. `Credential` records store WHERE material lives
(`custodyBackendRef` — env-file locally, Secret Manager on GCP), never values.
The custody broker (`apps/server/src/custody`, stubbed):

```ts
getBrokered(ref, p): Promise<BrokeredAuth>;      // scoped, short-lived, audited
mountSession(ref, host): Promise<SessionMount>;  // sealed browser profiles
```

Connectors receive `BrokeredAuth`, not keys; every issuance is an event.

> **Implemented in P3-connect**: `getBrokered` (plus server-internal
> `issueFor`/`redeem`) is real over the env-file backend — credential rows
> point at material via `custodyBackendRef: "env-file:<KEY>"`, resolved from
> the dotenv-style file at `LITHIS_SECRETS_FILE`. The handle carries a
> random 15-minute `brokerToken` redeemed in-process by the connector
> runtime; the secret never rides the handle, an event, or the API. Issuances
> emit `custody.credential.brokered`. `mountSession` remains stubbed until
> the browserhost lands (P12).

## Browserhost

`browser_session` credentials are **sealed custody assets**
([ADR-003](../adr/003-custody-and-browserhost.md)): real logged-in Chrome
profiles that mount ONLY into `apps/browserhost` pods — headed Chrome driven
over CDP, with timing-only humanization and CAPTCHA = pause + notify (a
HumanRequest, not a bypass). Cookies never enter agent context; agents get
brokered browser ACTIONS, and every action is a capability-checked event.
Egress from browser pods is currently unrestricted — an acknowledged open
question (`TODOS.md`, [threat model](../threat-model.md)).
