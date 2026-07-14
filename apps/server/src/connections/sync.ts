import { nowIso } from "@lithis/core";
import type { Connection } from "@lithis/core";
import type { IngestSink } from "@lithis/sdk/connectors";
import { txSql } from "../db";
import type { Db } from "../db";
import type { EventSpine, TickSource } from "../spine";
import type { ConnectorRuntime } from "./index";
import { applyHealthOutcome, rowToConnection } from "./shared";
import type { ConnectionRow } from "./shared";

/**
 * The scheduled-sync TickSource (orchestrator clock). Each tick finds
 * connections due for a sync, resolves their connector through the
 * ConnectorRuntime seam, and pulls every manifest feed from its stored cursor.
 * Success persists the returned cursors into syncState and emits
 * connector.sync.completed per feed; failure is recorded honestly in
 * syncState.lastError + health, and the health transition (healthy → degraded)
 * emits connection.health.changed. The clock never overlaps ticks in-process;
 * multi-orchestrator dedup is deferred with the rest of the multi-node story.
 */

export const DEFAULT_SYNC_INTERVAL_MINUTES = 5;

export interface SyncTickSourceDeps {
  db: Db;
  spine: EventSpine;
  runtime: ConnectorRuntime;
  /** Where synced content lands (server/context implements this for real in P4). */
  sink: IngestSink;
  /** Minimum minutes between sync ATTEMPTS per connection. */
  intervalMinutes?: number;
}

/**
 * Pure scheduling decision: disabled/expired connections never sync; others
 * sync when they have never been attempted or their last attempt is older
 * than the interval.
 */
export function isDueForSync(connection: Connection, now: Date, intervalMinutes: number): boolean {
  if (connection.status === "disabled" || connection.status === "expired") return false;
  const lastSyncAt = connection.syncState.lastSyncAt;
  if (lastSyncAt === undefined) return true;
  return now.getTime() - new Date(lastSyncAt).getTime() >= intervalMinutes * 60_000;
}

/** Wrap the sink so the loop can report how many docs a feed sync landed. */
function countingSink(inner: IngestSink): { sink: IngestSink; docs: () => number } {
  let docs = 0;
  return {
    sink: {
      putBlob: (input) => inner.putBlob(input),
      ingestDoc: async (input) => {
        const ref = await inner.ingestDoc(input);
        docs += 1;
        return ref;
      },
    },
    docs: () => docs,
  };
}

export function createSyncTickSource(deps: SyncTickSourceDeps): TickSource {
  const intervalMinutes = deps.intervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES;
  return {
    id: "connections.sync",
    async tick(now: Date): Promise<void> {
      const rows: ConnectionRow[] = await deps.db.sql`
        select * from connections.connections
        where status not in ('disabled', 'expired')
        order by created_at, id`;
      for (const row of rows) {
        const connection = rowToConnection(row);
        if (!isDueForSync(connection, now, intervalMinutes)) continue;
        await syncConnection(deps, connection);
      }
    },
  };
}

interface FeedResult {
  feed: string;
  newDocs: number;
  cursor: string;
}

async function syncConnection(deps: SyncTickSourceDeps, connection: Connection): Promise<void> {
  const connector = deps.runtime.resolve(connection.connectorSlug);
  const cursors = { ...connection.syncState.cursorsByFeed };
  const results: FeedResult[] = [];
  let error: string | undefined;

  if (connector === undefined) {
    error = `no connector registered for slug '${connection.connectorSlug}'`;
  } else {
    for (const feed of connector.manifest.feeds) {
      const counted = countingSink(deps.sink);
      try {
        const cursor = await connector.sync(
          connection,
          feed.key,
          cursors[feed.key] ?? null,
          counted.sink,
        );
        cursors[feed.key] = cursor;
        results.push({ feed: feed.key, newDocs: counted.docs(), cursor });
      } catch (err) {
        error = `feed '${feed.key}': ${err instanceof Error ? err.message : String(err)}`;
        break; // cursors from feeds that DID succeed still persist below
      }
    }
  }

  const at = nowIso();
  const syncState: Connection["syncState"] = {
    cursorsByFeed: cursors,
    lastSyncAt: at,
    ...(error !== undefined ? { lastError: error } : {}),
  };
  await deps.db.withTx(async (tx) => {
    await txSql(tx)`
      update connections.connections
      set sync_state = ${syncState}::jsonb, updated_at = now()
      where id = ${connection.id}`;
    for (const result of results) {
      await deps.spine.append(tx, {
        tenantId: connection.tenantId,
        topic: "connector.sync.completed",
        subjectRefs: [{ kind: "connection", id: connection.id }],
        actor: { kind: "connection", id: connection.id },
        payload: result,
      });
    }
    await applyHealthOutcome(tx, deps.spine, connection, {
      ok: error === undefined,
      ...(error !== undefined ? { error } : {}),
      at,
    });
  });
}
