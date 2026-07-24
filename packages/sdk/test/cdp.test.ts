import { afterEach, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import { CdpError, connectCdp } from "../src/cdp";

/**
 * The CDP transport over a REAL websocket (a scripted stand-in for the
 * browserhost broker) — no Chrome, no new dependencies.
 */

interface FakeEndpoint {
  url: string;
  /** Push an unsolicited CDP event to the connected client. */
  emit(frame: unknown): void;
  stop(): void;
}

const running: FakeEndpoint[] = [];

function startEndpoint(
  reply: (command: Record<string, unknown>) => unknown | undefined,
): FakeEndpoint {
  let socket: ServerWebSocket<undefined> | undefined;
  const server: Server<undefined> = Bun.serve<undefined>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("expected upgrade", { status: 400 });
    },
    websocket: {
      open(ws) {
        socket = ws;
      },
      message(ws, message) {
        const command = JSON.parse(
          typeof message === "string" ? message : message.toString(),
        ) as Record<string, unknown>;
        const response = reply(command);
        if (response !== undefined) ws.send(JSON.stringify(response));
      },
    },
  });
  const endpoint: FakeEndpoint = {
    url: `ws://127.0.0.1:${server.port}/cdp/x?token=t`,
    emit: (frame) => socket?.send(JSON.stringify(frame)),
    stop: () => server.stop(true),
  };
  running.push(endpoint);
  return endpoint;
}

describe("connectCdp", () => {
  let endpoint: FakeEndpoint;

  afterEach(() => {
    while (running.length > 0) running.pop()!.stop();
  });

  test("round-trips a command and resolves with its result", async () => {
    endpoint = startEndpoint((c) => ({ id: c["id"], result: { frameId: "f1" } }));
    const cdp = await connectCdp(endpoint.url);
    expect(await cdp.send("Page.navigate", { url: "https://example.com" })).toEqual({
      frameId: "f1",
    });
    await cdp.close();
  });

  test("a broker denial surfaces as a CdpError carrying the rule", async () => {
    endpoint = startEndpoint((c) => ({
      id: c["id"],
      error: { code: -32601, message: "hard-denied by the browserhost broker", data: "denied_method" },
    }));
    const cdp = await connectCdp(endpoint.url);
    const failure = cdp.send("Network.getAllCookies");
    await expect(failure).rejects.toThrow(CdpError);
    await expect(failure).rejects.toThrow(/denied_method/);
    await cdp.close();
  });

  test("events are dispatched by method and unsubscribe cleanly", async () => {
    endpoint = startEndpoint(() => undefined);
    const cdp = await connectCdp(endpoint.url);
    const seen: string[] = [];
    const off = cdp.on("Page.loadEventFired", () => seen.push("load"));
    endpoint.emit({ method: "Page.loadEventFired", params: {} });
    await Bun.sleep(10);
    off();
    endpoint.emit({ method: "Page.loadEventFired", params: {} });
    await Bun.sleep(10);
    expect(seen).toEqual(["load"]);
    await cdp.close();
  });

  test("commands time out instead of hanging forever", async () => {
    endpoint = startEndpoint(() => undefined);
    const cdp = await connectCdp(endpoint.url, { commandTimeoutMs: 25 });
    await expect(cdp.send("Page.navigate")).rejects.toThrow(/timed out after 25ms/);
    await cdp.close();
  });

  test("in-flight commands reject when the connection closes", async () => {
    endpoint = startEndpoint(() => undefined);
    const cdp = await connectCdp(endpoint.url);
    const inflight = cdp.send("Page.navigate");
    await cdp.close();
    await expect(inflight).rejects.toThrow(/CDP connection closed/);
  });
});
