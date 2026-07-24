import type { Connection, Ulid } from "@lithis/core";
import type { ArtifactEngine } from "../artifacts";
import type { ContextStore } from "../context";
import type { Delivery } from "../delivery";
import type { HumanGate } from "../humangate";
import type { SkillRegistry } from "../skills";
import type { SorRuntime } from "../sor";
import type { WorkQueue } from "../work";
import type { ServerRole } from "../config";

/**
 * The services the HTTP surface is built over. Route files depend on this
 * (not on index.ts) so the composer can import them without a cycle. New
 * phases add their service here and mount their route file in index.ts.
 */
export interface ApiDeps {
  role: ServerRole;
/** Absent when the server boots without DATABASE_URL (routes answer 503). */
  humanGate?: HumanGate;
  /** Absent when the server runs without a database — work routes answer 503. */
  workQueue?: WorkQueue;
  contextStore: ContextStore;
  /** Absent when the server runs without a database — delivery routes answer 503. */
  delivery?: Delivery;
  /** Absent when the server runs without a database — skills routes answer 503. */
  skills?: SkillRegistry;
  /** Absent when the server runs without a database — artifacts routes answer 503. */
  artifacts?: ArtifactEngine;
  /** Absent when the server runs without a database — sor routes answer 503. */
  sor?: SorRuntime;
  /** Resolves the tenant's slack connection for the inbound events ingress. */
  slackConnectionFor?: (tenantId: Ulid) => Promise<Connection | undefined>;
  /** Injectable for tests; defaults to construction time. */
  startedAtMs?: number;
}
