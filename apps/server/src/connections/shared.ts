import { connectionSchema, credentialSchema, feedExpectationSchema } from "@lithis/core";
import type { Connection, Credential, FeedExpectation } from "@lithis/core";
import { txSql } from "../db";
import type { DbTx } from "../db";
import type { EventSpine } from "../spine";

/**
 * Internal row plumbing shared by the connections module: Bun SQL row → zod
 * record mapping, and the one place a probe/sync outcome is turned into a
 * persisted health value + (on transition only) a connection.health.changed
 * event.
 */

/** Bun's SQL client returns jsonb columns as JSON text — parse before zod. */
export function fromJsonb(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

export function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export interface ConnectionRow {
  id: string;
  tenant_id: string;
  connector_slug: string;
  display_name: string;
  credential_ref: string;
  scopes: unknown;
  status: string;
  health: unknown;
  sync_state: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

export function rowToConnection(row: ConnectionRow): Connection {
  return connectionSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    connectorSlug: row.connector_slug,
    displayName: row.display_name,
    credentialRef: row.credential_ref,
    scopes: fromJsonb(row.scopes),
    status: row.status,
    health: fromJsonb(row.health),
    syncState: fromJsonb(row.sync_state),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

export interface FeedExpectationRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  key: string;
  expect_cadence: string;
  grace_minutes: number;
  last_seen_at: Date | string | null;
  missed_count: number;
  on_miss: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export function rowToFeedExpectation(row: FeedExpectationRow): FeedExpectation {
  return feedExpectationSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    connectionId: row.connection_id,
    key: row.key,
    expectCadence: row.expect_cadence,
    graceMinutes: row.grace_minutes,
    ...(row.last_seen_at !== null ? { lastSeenAt: toIso(row.last_seen_at) } : {}),
    missedCount: row.missed_count,
    onMiss: row.on_miss,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

export interface CredentialRow {
  id: string;
  tenant_id: string;
  kind: string;
  custody_backend_ref: string;
  holder_connection_id: string | null;
  rotates_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export function rowToCredential(row: CredentialRow): Credential {
  return credentialSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    custodyBackendRef: row.custody_backend_ref,
    ...(row.holder_connection_id !== null ? { holderConnectionId: row.holder_connection_id } : {}),
    ...(row.rotates_at !== null ? { rotatesAt: toIso(row.rotates_at) } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

export interface HealthOutcome {
  ok: boolean;
  error?: string;
  at: string;
}

/**
 * Fold a probe/sync outcome into the connection's persisted health + status,
 * inside the caller's transaction. Emits connection.health.changed ONLY when
 * the status actually transitions. `disabled` is sticky — callers skip
 * probing/syncing disabled connections, so it never reaches here flipped.
 */
export async function applyHealthOutcome(
  tx: DbTx,
  spine: EventSpine,
  connection: Connection,
  outcome: HealthOutcome,
): Promise<Connection["health"]> {
  const nextStatus: Connection["status"] = outcome.ok ? "healthy" : "degraded";
  const nextHealth: Connection["health"] = {
    ...(outcome.ok ? { lastOkAt: outcome.at } : connection.health.lastOkAt !== undefined ? { lastOkAt: connection.health.lastOkAt } : {}),
    ...(outcome.ok ? {} : { lastError: outcome.error ?? "probe failed" }),
  };
  await txSql(tx)`
    update connections.connections
    set status = ${nextStatus},
        health = ${nextHealth}::jsonb,
        updated_at = now()
    where id = ${connection.id}`;
  if (nextStatus !== connection.status) {
    await spine.append(tx, {
      tenantId: connection.tenantId,
      topic: "connection.health.changed",
      subjectRefs: [{ kind: "connection", id: connection.id }],
      actor: { kind: "connection", id: connection.id },
      payload: {
        from: connection.status,
        to: nextStatus,
        ...(outcome.ok ? {} : { error: outcome.error ?? "probe failed" }),
      },
      ...(outcome.ok ? {} : { severity: "warning" as const }),
    });
  }
  return nextHealth;
}
