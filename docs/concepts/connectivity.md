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
getBrokered(ref, p): Promise<BrokeredAuth>;   // scoped, short-lived, audited
mountSession(ref, p): Promise<SessionMount>;  // sealed browser profiles
```

Connectors receive `BrokeredAuth`, not keys; every issuance is an event.

> **Implemented in P3-connect**: `getBrokered` (plus server-internal
> `issueFor`/`redeem`) is real over the env-file backend — credential rows
> point at material via `custodyBackendRef: "env-file:<KEY>"`, resolved from
> the dotenv-style file at `LITHIS_SECRETS_FILE`. The handle carries a
> random 15-minute `brokerToken` redeemed in-process by the connector
> runtime; the secret never rides the handle, an event, or the API. Issuances
> emit `custody.credential.brokered`.
>
> **Implemented in P12-browser**: `mountSession(ref, p)` is real. It verifies
> `credential.kind === 'browser_session'`, resolves the SEALED profile through
> the custody browser-profile store (`browser-profile:<key>` refs → one
> directory per credential under `LITHIS_BROWSER_PROFILE_DIR`, default
> `~/.lithis/profiles`; object-storage backing arrives with P15-gcp), and mounts
> it through an injected `BrowserHostPort` — custody never imports
> `apps/browserhost` internals. The returned `SessionMount` carries a
> BROKERED, single-use CDP url, never the pod's raw DevTools endpoint. Mounts
> and releases emit `browser.session.mounted` / `browser.session.released`
> carrying ids only, and the CDP broker emits `browser.cdp.denied` for every
> refused command. The P3-era `host: BrowserHostRef` argument is gone: the
> injected port IS the pod, and the pod that served the mount comes back on the
> `SessionMount`.

## Browserhost

`browser_session` credentials are **sealed custody assets**
([ADR-003](../adr/003-custody-and-browserhost.md)): real logged-in Chrome
profiles that mount ONLY into `apps/browserhost` pods — headed Chrome driven
over CDP, with timing-only humanization and CAPTCHA = pause + notify (a
HumanRequest, not a bypass). Cookies never enter agent context; agents get
brokered browser ACTIONS, and every action is a capability-checked event.
Egress from browser pods is currently unrestricted — an acknowledged open
question (`TODOS.md`, [threat model](../threat-model.md)).

> **Implemented in P12-browser**: the pod runtime (unseal into an ephemeral pod
> directory → launch the system Chrome headed → broker → re-seal on release),
> the `ChromeLauncher` seam (`LITHIS_CHROME_BINARY`, standard install paths
> otherwise, loud failure when absent), and the CDP broker — a Bun websocket
> proxy requiring a single-use token, forwarding only an allow-listed
> navigate/extract/click/screenshot surface and hard-denying every
> cookie/storage-reading or -writing method. A refused command gets a CDP error
> back and emits `browser.cdp.denied`; it never silently passes through. See
> [apps/browserhost/README.md](../../apps/browserhost/README.md) for the
> allow/deny tables and the stated residual risk around `Runtime.evaluate`.
>
> Agents drive sessions through `@lithis/sdk`'s `openBrowserSession`, which
> speaks CDP over Bun's built-in WebSocket and paces every action through the
> host's `PaceGuard`. `captcha_pause` returns `ok: false` with its reason — it
> is never solved, never retried, never worked around.
