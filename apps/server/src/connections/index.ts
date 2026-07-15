import type {
  Connection,
  Credential,
  FeedExpectation,
  IsoDateTime,
  PrincipalContext,
  Ulid,
} from "@lithis/core";
import type { BrokeredAuth, Connector, IngestSink } from "@lithis/sdk/connectors";
import { stubValue } from "@lithis/stubkit";
import type { Db } from "../db";
import type { EventSpine } from "../spine";
import { createPgCredentialDirectory } from "./credentials";
import { countDueMisses, createFeedExpectationTickSource } from "./expectations";
import { createPgConnectionRegistry } from "./registry";
import { createConnectorRuntime } from "./runtime";
import { createSyncTickSource, isDueForSync } from "./sync";
import type { SyncTickSourceDeps } from "./sync";

/**
 * connections — one connector registry is both the integration surface
 * (pillar 2) and the ops face (pillar 11): instances, health, sync cursors,
 * and FeedExpectation SLAs (the "carrier SFTP loss-runs should arrive weekly"
 * watchdog). Misses emit feed.expectation.missed → flags/tasks.
 *
 * Real as of P3-connect: the Postgres registry, the ConnectorRuntime seam the
 * C-* connector phases register into, and the two clock TickSources
 * (feed-expectation grace windows + the scheduled sync loop).
 */

/** Expectation shape accepted at registration time (ids/counters are server-assigned). */
export type NewFeedExpectation = Pick<
  FeedExpectation,
  "key" | "expectCadence" | "graceMinutes" | "onMiss"
>;

export type NewConnection = Omit<
  Connection,
  "id" | "createdAt" | "updatedAt" | "status" | "health" | "syncState"
> & {
  /** Expected-feed SLAs to arm alongside the connection. */
  feedExpectations?: NewFeedExpectation[];
};

export interface ConnectionRegistry {
  register(input: NewConnection): Promise<Connection>;
  list(p: PrincipalContext): Promise<Connection[]>;
  /**
   * Server-internal lookup of the live connections for one connector slug —
   * tenant-scoped when tenantId is given, fleet-wide otherwise (e.g. the
   * Socket Mode wiring resolving which connection inbound Slack events belong
   * to). Excludes disabled connections.
   */
  findByConnector(connectorSlug: string, tenantId?: Ulid): Promise<Connection[]>;
  /** Probe + persist health; emits connection.health.changed on transitions. */
  health(connectionId: Ulid): Promise<Connection["health"]>;
  /** Feed arrival heartbeat — resets the FeedExpectation grace window. */
  recordFeedSeen(connectionId: Ulid, feedKey: string, at: IsoDateTime): Promise<void>;
}

/** A live health check for one connection (usually a connector's health hook). */
export interface HealthProbe {
  probe(connection: Connection): Promise<{ ok: boolean; error?: string }>;
}

/** Where the registry finds probes — the ConnectorRuntime implements this. */
export interface HealthProbeSource {
  probeFor(connection: Connection): HealthProbe | undefined;
}

/**
 * The auth path connectors use: custody mints the BrokeredAuth (opaque
 * brokerToken — NEVER secret material), and redeem() exchanges the token for
 * the actual header/token at call time, inside server-side connector code.
 */
export interface ConnectorAuthProvider {
  getAuth(connection: Connection): Promise<BrokeredAuth>;
  redeem(brokerToken: string): Promise<string>;
}

/** Connectors that need authenticated calls register as a factory over the provider. */
export type ConnectorFactory = (auth: ConnectorAuthProvider) => Connector;

/** The seam the sync loop and health probes resolve connectors through. */
export interface ConnectorRuntime extends HealthProbeSource {
  register(input: Connector | ConnectorFactory): Connector;
  resolve(slug: string): Connector | undefined;
  slugs(): string[];
}

export type NewCredential = Omit<Credential, "id" | "createdAt" | "updatedAt">;

/** Credential METADATA records (connections owns the table; custody looks up through this). */
export interface CredentialDirectory {
  create(input: NewCredential): Promise<Credential>;
  get(credentialId: Ulid): Promise<Credential | null>;
}

/**
 * Synced content lands as blobs + quarantined docs via server/context — that
 * ingest path is P4-context's surface, so until it exists the wired sink is a
 * loud stub. Tests (and later main.ts wiring) inject real sinks through
 * SyncTickSourceDeps.
 */
const pendingIngestSink = stubValue<IngestSink>(
  "server.connections.sync.ingest-sink",
  "LITHIS-STUB: connector ingest sink not implemented — synced blobs/docs land via the context module (P4-context)",
);

export function createPendingIngestSink(): IngestSink {
  return pendingIngestSink;
}

export function createConnectionRegistry(
  db: Db,
  spine: EventSpine,
  opts?: { probes?: HealthProbeSource },
): ConnectionRegistry {
  return createPgConnectionRegistry(db, spine, opts);
}

export function createCredentialDirectory(db: Db, spine: EventSpine): CredentialDirectory {
  return createPgCredentialDirectory(db, spine);
}

export {
  countDueMisses,
  createConnectorRuntime,
  createFeedExpectationTickSource,
  createSyncTickSource,
  isDueForSync,
};
export type { SyncTickSourceDeps };
