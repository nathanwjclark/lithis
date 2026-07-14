import type { Connection, IsoDateTime, PrincipalContext, Ulid } from "@lithis/core";
import { stubService } from "@lithis/stubkit";

/**
 * connections — one connector registry is both the integration surface
 * (pillar 2) and the ops face (pillar 11): instances, health, sync cursors,
 * and FeedExpectation SLAs (the "carrier SFTP loss-runs should arrive weekly"
 * watchdog). Misses emit feed.expectation.missed → flags/tasks.
 */

export type NewConnection = Omit<
  Connection,
  "id" | "createdAt" | "updatedAt" | "status" | "health" | "syncState"
>;

export interface ConnectionRegistry {
  register(input: NewConnection): Promise<Connection>;
  list(p: PrincipalContext): Promise<Connection[]>;
  /** Probe + persist health; emits connection.health.changed on transitions. */
  health(connectionId: Ulid): Promise<Connection["health"]>;
  /** Feed arrival heartbeat — resets the FeedExpectation grace window. */
  recordFeedSeen(connectionId: Ulid, feedKey: string, at: IsoDateTime): Promise<void>;
}

const connectionRegistry = stubService<ConnectionRegistry>(
  "server.connections.registry",
  ["register", "list", "health", "recordFeedSeen"],
  "LITHIS-STUB: connector instance registry, health probing, and FeedExpectation tracking not implemented",
);

export function createConnectionRegistry(): ConnectionRegistry {
  return connectionRegistry;
}
