import type { Server, ServerWebSocket } from "bun";
import { cdpDenialError, decideCdpCommand } from "./cdp-policy";
import type { CdpDecision } from "./cdp-policy";

/**
 * The CDP broker — a Bun websocket proxy in front of the pod's raw DevTools
 * endpoint. Callers NEVER get the pod endpoint: they get a loopback URL
 * carrying a single-use broker token, and every command they send is policed
 * by ./cdp-policy before it reaches Chrome.
 *
 * A refused command is answered with a CDP error carrying the same `id` the
 * caller sent (so its promise rejects instead of hanging) and reported through
 * `onDecision` — the server turns that into a spine event. Nothing is ever
 * silently dropped, and nothing refused reaches the browser.
 */

export interface CdpBrokerDenial {
  sessionId: string;
  method: string;
  rule: Extract<CdpDecision, { allow: false }>["rule"];
  reason: string;
  at: string;
}

export interface CdpBrokerOptions {
  /** The mounted session this broker fronts (used in the URL path + events). */
  sessionId: string;
  /** The pod's raw DevTools endpoint — never handed to a caller. */
  upstreamWsUrl: string;
  /** Reported for every refused command; the server emits a spine event. */
  onDenied?: (denial: CdpBrokerDenial) => void;
  /** Loopback only by default — the broker is a pod-local hop, not a service. */
  hostname?: string;
  /** Injectable upstream factory (tests substitute a fake CDP endpoint). */
  connectUpstream?: (url: string) => WebSocket;
}

export interface CdpBroker {
  /** The brokered URL handed to callers: single-use token, loopback host. */
  wsUrl: string;
  port: number;
  /** True once the single-use token has been redeemed. */
  get redeemed(): boolean;
  close(): Promise<void>;
}

interface SocketData {
  clientId: number;
}

function newToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `cdp_${Buffer.from(bytes).toString("base64url")}`;
}

/**
 * Start a broker for one mounted session. The returned URL is valid for
 * exactly one websocket upgrade; a second attempt (or a wrong/absent token) is
 * refused with 401 before any upstream connection is made.
 */
export function createCdpBroker(opts: CdpBrokerOptions): CdpBroker {
  const token = newToken();
  const hostname = opts.hostname ?? "127.0.0.1";
  const connectUpstream = opts.connectUpstream ?? ((url: string) => new WebSocket(url));

  let redeemed = false;
  let upstream: WebSocket | undefined;
  let client: ServerWebSocket<SocketData> | undefined;
  /** Commands that arrived before the upstream socket finished opening. */
  const pending: string[] = [];

  function flush(): void {
    if (upstream === undefined || upstream.readyState !== WebSocket.OPEN) return;
    while (pending.length > 0) upstream.send(pending.shift()!);
  }

  function forwardToClient(data: string | ArrayBufferLike): void {
    if (client === undefined) return;
    client.send(data as string);
  }

  function handleClientMessage(raw: string): void {
    let command: unknown;
    try {
      command = JSON.parse(raw);
    } catch {
      forwardToClient(
        JSON.stringify({
          error: {
            code: -32700,
            message: "browserhost CDP broker: command was not valid JSON",
            data: "parse_error",
          },
        }),
      );
      return;
    }
    const parsed = (command ?? {}) as { id?: number; method?: unknown; sessionId?: string };
    const decision = decideCdpCommand(parsed);
    if (!decision.allow) {
      const method = typeof parsed.method === "string" ? parsed.method : "(none)";
      opts.onDenied?.({
        sessionId: opts.sessionId,
        method,
        rule: decision.rule,
        reason: decision.reason,
        at: new Date().toISOString(),
      });
      forwardToClient(
        JSON.stringify({
          ...(parsed.id !== undefined ? { id: parsed.id } : {}),
          ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
          error: cdpDenialError(decision),
        }),
      );
      return;
    }
    if (upstream !== undefined && upstream.readyState === WebSocket.OPEN) {
      upstream.send(raw);
    } else {
      pending.push(raw);
    }
  }

  const server: Server<SocketData> = Bun.serve<SocketData>({
    port: 0,
    hostname,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== `/cdp/${opts.sessionId}`) {
        return new Response("not found", { status: 404 });
      }
      if (redeemed || url.searchParams.get("token") !== token) {
        return new Response("browserhost CDP broker: invalid or already-redeemed broker token", {
          status: 401,
        });
      }
      redeemed = true;
      if (srv.upgrade(req, { data: { clientId: 1 } })) return undefined;
      return new Response("expected a websocket upgrade", { status: 400 });
    },
    websocket: {
      open(ws) {
        client = ws;
        upstream = connectUpstream(opts.upstreamWsUrl);
        upstream.addEventListener("open", () => flush());
        upstream.addEventListener("message", (ev: MessageEvent) => {
          forwardToClient(ev.data as string);
        });
        upstream.addEventListener("close", () => {
          client?.close(1011, "browserhost: upstream CDP endpoint closed");
        });
        upstream.addEventListener("error", () => {
          client?.close(1011, "browserhost: upstream CDP endpoint errored");
        });
      },
      message(_ws, message) {
        handleClientMessage(typeof message === "string" ? message : message.toString());
      },
      close() {
        client = undefined;
        try {
          upstream?.close();
        } catch {
          // The upstream may already be gone; releasing the pod is what matters.
        }
      },
    },
  });

  const port = server.port;
  if (port === undefined) {
    throw new Error("browserhost CDP broker: Bun.serve did not report a listening port");
  }

  return {
    wsUrl: `ws://${hostname}:${port}/cdp/${opts.sessionId}?token=${token}`,
    port,
    get redeemed(): boolean {
      return redeemed;
    },
    async close(): Promise<void> {
      try {
        upstream?.close();
      } catch {
        // Already closed.
      }
      client?.close(1001, "browserhost: session released");
      server.stop(true);
    },
  };
}
