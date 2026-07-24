import type { Connection, Ulid } from "@lithis/core";
import type { ContextStore } from "../context";
import type { Delivery } from "../delivery";
import type { HumanGate } from "../humangate";
import type { ActionIntentService } from "../iam";
import type { SkillRegistry } from "../skills";
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
  /** Absent when the server runs without a database — action-batch routes answer 503. */
  actions?: ActionIntentService;
  /** Resolves the tenant's slack connection for the inbound events ingress. */
  slackConnectionFor?: (tenantId: Ulid) => Promise<Connection | undefined>;
  /** Injectable for tests; defaults to construction time. */
  startedAtMs?: number;
}
