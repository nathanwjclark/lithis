# @lithis/connector-filedrop

Watched-path ingestion for counterparties that deliver by dropping files:
carrier SFTP loss runs, commission statements landing in an S3 bucket, a
regulator's upload folder.

## How it works

- One connection = one remote root (SFTP host+path or S3 bucket+prefix over an
  SSH/credentialed session). Each configured watched path is a **feed**; new or
  modified files under it become Blobs + quarantined Docs (`file_drop`), keyed
  by an mtime/etag watermark cursor so sync is idempotent.
- `authKind: 'ssh'` — the key/credential is custody-brokered like everything
  else; the connector never sees raw secret material.
- **No actions.** Filedrop is ingest-only; lithis never writes into a
  counterparty's drop zone.

## Pair watched paths with FeedExpectation

Filedrop feeds are exactly what `FeedExpectation` (in `@lithis/core`
connectivity) exists for: a carrier that is *supposed* to drop loss runs every
Monday is an expectation like

- `key: "carrier-sftp:loss-runs"`, `expectCadence: "0 9 * * 1"`,
  `graceMinutes: 240`, `onMiss: "both"`.

The clock checks grace windows and emits `feed.expectation.missed`, which
turns into a flag and/or a WorkItem — "the loss runs didn't arrive" becomes an
agent task instead of a silent gap. Configure a FeedExpectation for every
watched path that has a promised cadence.
