import type { ContextStore } from "../context";
import type { HumanGate } from "../humangate";
import type { WorkQueue } from "../work";
import type { ServerRole } from "../config";

/**
 * The services the HTTP surface is built over. Route files depend on this
 * (not on index.ts) so the composer can import them without a cycle. New
 * phases add their service here and mount their route file in index.ts.
 */
export interface ApiDeps {
  role: ServerRole;
  humanGate: HumanGate;
  workQueue: WorkQueue;
  contextStore: ContextStore;
  /** Injectable for tests; defaults to construction time. */
  startedAtMs?: number;
}
