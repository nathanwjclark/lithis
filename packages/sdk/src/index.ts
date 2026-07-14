import type {
  Audience,
  HumanRequest,
  HumanRequestState,
  HumanResolution,
  Ref,
  Ulid,
  WorkItem,
} from "@lithis/core";
import type { StubCensus } from "@lithis/stubkit";
import { stubService } from "@lithis/stubkit";

/**
 * @lithis/sdk — the typed client for the lithis server API plus the authoring
 * kits (connectors, skills, templates, browser). The contracts here are REAL;
 * the HTTP client implementation is a registered stub until apps/server's api
 * module lands.
 */

export * from "./connectors";
export * from "./skills";
export * from "./templates";
export * from "./browser";

export interface InboxFilter {
  state?: HumanRequestState;
  kind?: HumanRequest["kind"];
  /** Only requests assigned to this principal/role. */
  assignee?: Ref | string;
  limit?: number;
}

export interface SearchQuery {
  text: string;
  /** Degree choke point — defaults to 'network' server-side. */
  audience?: Audience;
  limit?: number;
}

export interface ScoredRef {
  ref: Ref;
  score: number;
  /** Short snippet/why for evidence-first rendering. */
  excerpt?: string;
}

/** Client-side work item creation payload; server assigns ids/status/timestamps. */
export type NewWorkItemInput = Pick<WorkItem, "kind" | "title"> &
  Partial<Pick<WorkItem, "body" | "priority" | "dueAt" | "wakeAt" | "schedule" | "sourceRefs">> & {
    ownerPrincipalId?: Ulid;
  };

export interface LithisClient {
  /** The caller's pending HumanRequests (evidence-first inbox). */
  inbox(filter?: InboxFilter): Promise<HumanRequest[]>;
  /** Resolve a HumanRequest: approve / deny / modify / answer / acknowledge. */
  resolveRequest(id: Ulid, resolution: Omit<HumanResolution, "at">): Promise<HumanRequest>;
  /** Hybrid context search (FTS + vector), audience-guarded server-side. */
  search(query: SearchQuery): Promise<ScoredRef[]>;
  /** Open a work item on the global queue. */
  openWorkItem(item: NewWorkItemInput): Promise<WorkItem>;
  /** The server's live stub census — the "what's real yet" feed. */
  stubs(): Promise<StubCensus>;
}

/**
 * Registered once at module load: every method throws NotImplementedError
 * until the server api module exists, so nothing can mistake the skeleton
 * client for a working one.
 */
const stubClient = stubService<LithisClient>(
  "sdk.client",
  ["inbox", "resolveRequest", "search", "openWorkItem", "stubs"],
  "LITHIS-STUB: HTTP client against apps/server api not implemented — lands with the spine + humangate build-out",
);

/**
 * Create a client for a lithis server. The baseUrl is validated for real;
 * every method on the returned client is a registered stub.
 */
export function createLithisClient(baseUrl: string): LithisClient {
  // Throws TypeError on malformed URLs — validation is real even though the
  // transport is not.
  new URL(baseUrl);
  return stubClient;
}
