import type { Connection, Ref } from "@lithis/core";
import { newUlid, nowIso } from "@lithis/core";
import type { ConnectorAuthProvider, IngestSink, NewBlobInput, NewDocInput } from "@lithis/sdk";

/**
 * Fixture-replay harness: an injected fetch that routes Slack Web API calls
 * to recorded JSON fixtures, plus a recording IngestSink and a fake
 * custody-style auth provider. Test-only code — fixture data lives in
 * ../fixtures, exactly where it belongs.
 */

export interface RecordedCall {
  method: string;
  httpMethod: string;
  params: Record<string, string | unknown>;
  authorization: string | null;
}

export interface FixtureRoute {
  /** Slack method name, e.g. "conversations.history". */
  method: string;
  /** Narrow by request params (GET query or POST JSON body). */
  match?: (params: Record<string, unknown>) => boolean;
  /** Fixture JSON body. */
  body: unknown;
  /** HTTP status (429 for rate-limit replays). */
  status?: number;
  headers?: Record<string, string>;
  /** How many times this route may serve before falling through (default unlimited). */
  times?: number;
}

export interface FakeSlack {
  fetch: typeof globalThis.fetch;
  calls: RecordedCall[];
  callsTo(method: string): RecordedCall[];
}

export function fakeSlackFetch(routes: FixtureRoute[]): FakeSlack {
  const remaining = routes.map((route) => ({ route, left: route.times ?? Infinity }));
  const calls: RecordedCall[] = [];

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = url.pathname.replace(/^\/api\//, "").replace(/^\//, "");
    const httpMethod = init?.method ?? "GET";
    let params: Record<string, unknown> = Object.fromEntries(url.searchParams.entries());
    if (httpMethod === "POST" && typeof init?.body === "string" && init.body !== "") {
      params = JSON.parse(init.body) as Record<string, unknown>;
    }
    const headers = new Headers(init?.headers);
    calls.push({ method, httpMethod, params, authorization: headers.get("authorization") });

    for (const entry of remaining) {
      if (entry.left <= 0) continue;
      if (entry.route.method !== method) continue;
      if (entry.route.match !== undefined && !entry.route.match(params)) continue;
      entry.left -= 1;
      return new Response(JSON.stringify(entry.route.body), {
        status: entry.route.status ?? 200,
        headers: { "content-type": "application/json; charset=utf-8", ...entry.route.headers },
      });
    }
    throw new Error(
      `fake slack: no fixture route for ${method} with params ${JSON.stringify(params)}`,
    );
  }) as typeof globalThis.fetch;

  return { fetch: fakeFetch, calls, callsTo: (m) => calls.filter((c) => c.method === m) };
}

// ── recording IngestSink ────────────────────────────────────────────────────

export interface RecordingSink extends IngestSink {
  blobs: { ref: Ref; input: NewBlobInput }[];
  docs: { ref: Ref; input: NewDocInput }[];
}

export function recordingSink(): RecordingSink {
  const blobs: RecordingSink["blobs"] = [];
  const docs: RecordingSink["docs"] = [];
  return {
    blobs,
    docs,
    async putBlob(input) {
      const ref: Ref = { kind: "blob", id: newUlid() };
      blobs.push({ ref, input });
      return ref;
    },
    async ingestDoc(input) {
      const ref: Ref = { kind: "doc", id: newUlid() };
      docs.push({ ref, input });
      return ref;
    },
  };
}

// ── fake custody auth provider + connection ─────────────────────────────────

export const FAKE_BROKER_TOKEN = "bkr_test_opaque_handle";
export const FAKE_BOT_TOKEN = "xoxb-test-0000-redeemed";

/** Mirrors the server seam: getAuth hands out an opaque brokerToken; redeem exchanges it. */
export function fakeAuthProvider(): ConnectorAuthProvider & { redemptions: string[] } {
  const redemptions: string[] = [];
  return {
    redemptions,
    async getAuth() {
      return { kind: "oauth_token", token: FAKE_BROKER_TOKEN, expiresAt: nowIso() };
    },
    async redeem(brokerToken) {
      redemptions.push(brokerToken);
      if (brokerToken !== FAKE_BROKER_TOKEN) throw new Error("unknown or expired broker token");
      return FAKE_BOT_TOKEN;
    },
  };
}

export function fakeConnection(): Connection {
  const at = nowIso();
  return {
    id: newUlid(),
    tenantId: newUlid(),
    createdAt: at,
    updatedAt: at,
    connectorSlug: "slack",
    displayName: "Lithis HQ Slack",
    credentialRef: newUlid(),
    scopes: ["channels:read", "channels:history", "groups:read", "groups:history", "chat:write", "users:read"],
    status: "healthy",
    health: {},
    syncState: { cursorsByFeed: {} },
  };
}
