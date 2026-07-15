import { afterEach, describe, expect, test } from "bun:test";
import { createSocketModeClient } from "../src/delivery";

/**
 * Socket Mode client against an in-process fake: Bun.serve provides the
 * websocket server, a routed fetch fakes apps.connections.open. Covers the
 * protocol essentials — Bearer app-token auth on the open call, envelope
 * acking by envelope_id, events_api payload dispatch, and reconnect after a
 * server-initiated disconnect frame.
 */

type ServerHandle = {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  sockets: Set<Bun.ServerWebSocket<unknown>>;
  received: string[];
};

function fakeSlackSocketServer(): ServerHandle {
  const sockets = new Set<Bun.ServerWebSocket<unknown>>();
  const received: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined as unknown as Response;
      return new Response("not a websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify({ type: "hello", num_connections: 1 }));
      },
      message(_ws, message) {
        received.push(typeof message === "string" ? message : "");
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });
  return { server, url: `ws://localhost:${server.port}`, sockets, received };
}

function openFetch(handle: () => ServerHandle, calls: { authorization: string | null }[]) {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ authorization: headers.get("authorization") });
    return new Response(JSON.stringify({ ok: true, url: handle().url }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

async function until(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe("slack socket mode client", () => {
  test("connects with the app token, acks envelopes, dispatches events_api payloads", async () => {
    const handle = fakeSlackSocketServer();
    cleanups.push(() => handle.server.stop(true));
    const openCalls: { authorization: string | null }[] = [];
    const events: { event: unknown; teamId: string | undefined }[] = [];

    const client = createSocketModeClient({
      appToken: "xapp-test-token",
      onEvent: async (event, teamId) => {
        events.push({ event, teamId });
      },
      fetch: openFetch(() => handle, openCalls),
      sleep: () => new Promise((r) => setTimeout(r, 5)),
      log: () => {},
    });
    cleanups.push(() => client.stop());

    await client.start();
    await until(() => handle.sockets.size === 1 && client.connected());
    expect(openCalls[0]?.authorization).toBe("Bearer xapp-test-token");

    const socket = [...handle.sockets][0]!;
    socket.send(
      JSON.stringify({
        type: "events_api",
        envelope_id: "env-1",
        payload: {
          team_id: "T0100",
          event: { type: "message", channel: "C01", ts: "1.2", text: "approve", user: "U1" },
        },
      }),
    );

    await until(() => events.length === 1);
    expect(events[0]!.teamId).toBe("T0100");
    expect((events[0]!.event as { text: string }).text).toBe("approve");
    // The envelope was acked by id.
    await until(() => handle.received.some((m) => m.includes("env-1")));
    expect(JSON.parse(handle.received.find((m) => m.includes("env-1"))!)).toEqual({
      envelope_id: "env-1",
    });
  });

  test("reconnects after a disconnect frame and stops cleanly", async () => {
    const handle = fakeSlackSocketServer();
    cleanups.push(() => handle.server.stop(true));
    const openCalls: { authorization: string | null }[] = [];

    const client = createSocketModeClient({
      appToken: "xapp-test-token",
      onEvent: async () => {},
      fetch: openFetch(() => handle, openCalls),
      sleep: () => new Promise((r) => setTimeout(r, 5)),
      log: () => {},
    });
    cleanups.push(() => client.stop());

    await client.start();
    await until(() => handle.sockets.size === 1);

    // Slack refreshes sockets with a disconnect frame — the client must dial back in.
    [...handle.sockets][0]!.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
    await until(() => openCalls.length >= 2 && handle.sockets.size === 1);

    await client.stop();
    await until(() => handle.sockets.size === 0);
    expect(client.connected()).toBe(false);
  });

  test("a failed apps.connections.open resolves start() and keeps retrying until stop", async () => {
    let attempts = 0;
    const client = createSocketModeClient({
      appToken: "xapp-test-token",
      onEvent: async () => {},
      fetch: (async () => {
        attempts += 1;
        return new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof globalThis.fetch,
      sleep: () => new Promise((r) => setTimeout(r, 5)),
      log: () => {},
    });
    cleanups.push(() => client.stop());

    await client.start(); // resolves despite the failure — the loop owns retries
    await until(() => attempts >= 2);
    await client.stop();
    const settled = attempts;
    await new Promise((r) => setTimeout(r, 50));
    expect(attempts).toBe(settled); // no zombie retries after stop
  });
});
