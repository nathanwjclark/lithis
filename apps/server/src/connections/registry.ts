import { connectionSchema, newUlid, nowIso } from "@lithis/core";
import type { Connection, IsoDateTime, PrincipalContext, Ulid } from "@lithis/core";
import { txSql } from "../db";
import type { Db } from "../db";
import type { EventSpine } from "../spine";
import type { ConnectionRegistry, HealthProbeSource, NewConnection } from "./index";
import { applyHealthOutcome, rowToConnection } from "./shared";
import type { ConnectionRow } from "./shared";

/**
 * Postgres-backed connection registry: connector instances, health probing,
 * and FeedExpectation heartbeats. Every mutation rides the transactional
 * outbox; health probes emit connection.health.changed only on transitions.
 */

export async function loadConnection(db: Db, connectionId: Ulid): Promise<Connection> {
  const rows: ConnectionRow[] = await db.sql`
    select * from connections.connections where id = ${connectionId}`;
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`connection ${connectionId} not found`);
  }
  return rowToConnection(row);
}

export function createPgConnectionRegistry(
  db: Db,
  spine: EventSpine,
  opts?: { probes?: HealthProbeSource },
): ConnectionRegistry {
  return {
    async register(input: NewConnection): Promise<Connection> {
      const id = newUlid();
      const at = nowIso();
      const { feedExpectations, ...record } = input;
      // Initial state per the schema defaults: healthy until a probe/sync says
      // otherwise, empty health, no cursors.
      const connection = connectionSchema.parse({
        ...record,
        id,
        status: "healthy",
        health: {},
        syncState: { cursorsByFeed: {} },
        createdAt: at,
        updatedAt: at,
      });
      await db.withTx(async (tx) => {
        await txSql(tx)`
          insert into connections.connections
            (id, tenant_id, connector_slug, display_name, credential_ref, scopes,
             status, health, sync_state, created_at, updated_at)
          values
            (${id}, ${connection.tenantId}, ${connection.connectorSlug},
             ${connection.displayName}, ${connection.credentialRef},
             ${connection.scopes}::jsonb, ${connection.status},
             ${connection.health}::jsonb,
             ${connection.syncState}::jsonb, ${at}, ${at})`;
        for (const expectation of feedExpectations ?? []) {
          await txSql(tx)`
            insert into connections.feed_expectations
              (id, tenant_id, connection_id, key, expect_cadence, grace_minutes,
               missed_count, on_miss, created_at, updated_at)
            values
              (${newUlid()}, ${connection.tenantId}, ${id}, ${expectation.key},
               ${expectation.expectCadence}, ${expectation.graceMinutes}, 0,
               ${expectation.onMiss}, ${at}, ${at})`;
        }
        await spine.append(tx, {
          tenantId: connection.tenantId,
          topic: "connection.registered",
          subjectRefs: [
            { kind: "connection", id },
            { kind: "credential", id: connection.credentialRef },
          ],
          actor: { kind: "connection", id },
          payload: { connectorSlug: connection.connectorSlug, displayName: connection.displayName },
        });
      });
      return connection;
    },

    async list(p: PrincipalContext): Promise<Connection[]> {
      const rows: ConnectionRow[] = await db.sql`
        select * from connections.connections
        where tenant_id = ${p.tenantId}
        order by created_at, id`;
      return rows.map(rowToConnection);
    },

    async health(connectionId: Ulid): Promise<Connection["health"]> {
      const connection = await loadConnection(db, connectionId);
      // Disabled is an operator decision, not a probe result — never probe it back to life.
      if (connection.status === "disabled") return connection.health;
      const probe = opts?.probes?.probeFor(connection);
      const at = nowIso();
      let outcome: { ok: boolean; error?: string };
      if (probe !== undefined) {
        try {
          outcome = await probe.probe(connection);
        } catch (err) {
          outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      } else {
        // No live probe available (no connector registered for this slug):
        // the honest answer is derived from the last sync outcome.
        outcome =
          connection.syncState.lastError !== undefined
            ? { ok: false, error: connection.syncState.lastError }
            : { ok: true };
      }
      return await db.withTx((tx) => applyHealthOutcome(tx, spine, connection, { ...outcome, at }));
    },

    async recordFeedSeen(connectionId: Ulid, feedKey: string, at: IsoDateTime): Promise<void> {
      const connection = await loadConnection(db, connectionId);
      await db.withTx(async (tx) => {
        const existing: { missed_count: number }[] = await txSql(tx)`
          select missed_count from connections.feed_expectations
          where connection_id = ${connectionId} and key = ${feedKey}
          for update`;
        if (existing.length === 0) {
          throw new Error(`no feed expectation '${feedKey}' on connection ${connectionId}`);
        }
        const previousMissedCount = existing[0]!.missed_count;
        await txSql(tx)`
          update connections.feed_expectations
          set last_seen_at = ${at}, missed_count = 0, updated_at = now()
          where connection_id = ${connectionId} and key = ${feedKey}`;
        // A routine heartbeat is a watermark update, not a state transition;
        // only a recovery (the feed WAS missed) is an event.
        if (previousMissedCount > 0) {
          await spine.append(tx, {
            tenantId: connection.tenantId,
            topic: "feed.expectation.recovered",
            subjectRefs: [{ kind: "connection", id: connectionId }],
            actor: { kind: "connection", id: connectionId },
            payload: { key: feedKey, missedCount: previousMissedCount },
          });
        }
      });
    },
  };
}
