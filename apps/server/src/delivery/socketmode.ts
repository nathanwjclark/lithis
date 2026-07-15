import { z } from "zod";

/**
 * A lean Slack Socket Mode client over Bun's built-in WebSocket — no
 * @slack/socket-mode dependency. Protocol: POST apps.connections.open with
 * the app-level token (xapp-...) → wss URL → receive envelopes, ack each by
 * envelope_id, hand events_api payloads to the handler. `disconnect` frames
 * (Slack refreshes sockets regularly) and socket closes both trigger a
 * reconnect with linear backoff until stop() is called.
 *
 * The transport (fetch, WebSocket constructor, sleep) is injectable so tests
 * run against an in-process Bun.serve websocket fake.
 */

export const SLACK_CONNECTIONS_OPEN_URL = "https://slack.com/api/apps.connections.open";
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;

const connectionsOpenResponseSchema = z
  .object({ ok: z.boolean(), url: z.string().optional(), error: z.string().optional() })
  .passthrough();

const envelopeSchema = z
  .object({
    type: z.string(),
    envelope_id: z.string().optional(),
    payload: z.unknown().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

/** The events_api envelope payload: the Events-API body (team_id, event, ...). */
const eventsApiPayloadSchema = z
  .object({ team_id: z.string().optional(), event: z.unknown() })
  .passthrough();

export interface SocketModeOptions {
  /** Slack app-level token (xapp-...), NOT the bot token. */
  appToken: string;
  /** Receives the inner Slack event object for every events_api envelope. */
  onEvent: (event: unknown, teamId: string | undefined) => Promise<void>;
  fetch?: typeof globalThis.fetch;
  /** WebSocket constructor — Bun's global in production, a fake in tests. */
  webSocket?: typeof WebSocket;
  sleep?: (ms: number) => Promise<void>;
  connectionsOpenUrl?: string;
  log?: (line: string) => void;
}

export interface SocketModeClient {
  /** Connect and keep reconnecting until stop(). Resolves once the first socket opens (or first attempt fails). */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** True while a socket is open. */
  connected(): boolean;
}

export function createSocketModeClient(opts: SocketModeOptions): SocketModeClient {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const WS = opts.webSocket ?? WebSocket;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const openUrl = opts.connectionsOpenUrl ?? SLACK_CONNECTIONS_OPEN_URL;
  const log = opts.log ?? ((line: string) => console.log(line));

  let running = false;
  let socket: WebSocket | undefined;
  let loop: Promise<void> | undefined;
  let wakeForStop: (() => void) | undefined;

  /** Backoff sleep that returns immediately when stop() is called. */
  function backoff(ms: number): Promise<void> {
    return Promise.race([
      sleep(ms),
      new Promise<void>((r) => {
        wakeForStop = r;
      }),
    ]);
  }

  async function openSocketUrl(): Promise<string> {
    const response = await doFetch(openUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.appToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    if (!response.ok) {
      throw new Error(`apps.connections.open: HTTP ${response.status}`);
    }
    const body = connectionsOpenResponseSchema.parse(await response.json());
    if (!body.ok || body.url === undefined) {
      throw new Error(`apps.connections.open: ${body.error ?? "no url in response"}`);
    }
    return body.url;
  }

  /** One socket session: connect, pump messages, resolve when it closes. */
  function session(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let opened = false;
      const ws = new WS(url);
      socket = ws;
      ws.onopen = () => {
        opened = true;
        log("slack socket mode: connected");
      };
      ws.onmessage = (message: MessageEvent) => {
        void handleFrame(ws, typeof message.data === "string" ? message.data : "");
      };
      ws.onerror = () => {
        if (!opened) reject(new Error("slack socket mode: websocket failed to connect"));
      };
      ws.onclose = () => {
        socket = undefined;
        if (opened) resolve();
        else reject(new Error("slack socket mode: websocket closed before opening"));
      };
    });
  }

  async function handleFrame(ws: WebSocket, data: string): Promise<void> {
    let envelope: z.infer<typeof envelopeSchema>;
    try {
      envelope = envelopeSchema.parse(JSON.parse(data));
    } catch {
      log(`slack socket mode: unparseable frame ignored: ${data.slice(0, 120)}`);
      return;
    }
    // Ack FIRST — Slack redelivers unacked envelopes; our spine consumers are
    // idempotent enough (docs re-ingest, resolves are transition-guarded).
    if (envelope.envelope_id !== undefined) {
      ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }
    switch (envelope.type) {
      case "hello":
        return;
      case "disconnect":
        log(`slack socket mode: server asked to reconnect (${envelope.reason ?? "no reason"})`);
        ws.close();
        return;
      case "events_api": {
        const payload = eventsApiPayloadSchema.safeParse(envelope.payload);
        if (!payload.success) {
          log("slack socket mode: events_api envelope without an event — ignored");
          return;
        }
        try {
          await opts.onEvent(payload.data.event, payload.data.team_id);
        } catch (err) {
          // The envelope is already acked; the failure is ours to log loudly.
          console.error("slack socket mode: event handler failed:", err);
        }
        return;
      }
      default:
        return; // interactive/slash_commands etc. — not subscribed, ignore
    }
  }

  async function runLoop(firstAttempt: { resolve: () => void }): Promise<void> {
    let failures = 0;
    let signaled = false;
    while (running) {
      try {
        const url = await openSocketUrl();
        if (!signaled) {
          signaled = true;
          firstAttempt.resolve();
        }
        await session(url);
        failures = 0;
      } catch (err) {
        failures += 1;
        console.error(
          `slack socket mode: connection attempt failed (${failures}):`,
          err instanceof Error ? err.message : err,
        );
        if (!signaled) {
          signaled = true;
          firstAttempt.resolve();
        }
      }
      if (!running) break;
      await backoff(Math.min(RECONNECT_BASE_MS * Math.max(failures, 1), RECONNECT_CAP_MS));
    }
  }

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;
      let resolveFirst: () => void = () => {};
      const first = new Promise<void>((r) => {
        resolveFirst = r;
      });
      loop = runLoop({ resolve: resolveFirst });
      await first;
    },
    async stop(): Promise<void> {
      running = false;
      wakeForStop?.();
      socket?.close();
      await loop;
      loop = undefined;
    },
    connected(): boolean {
      return socket !== undefined && socket.readyState === WebSocket.OPEN;
    },
  };
}
