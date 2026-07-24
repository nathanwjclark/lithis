import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import { createCdpBroker } from "../src/index";
import type { CdpBroker, CdpBrokerDenial } from "../src/index";

/**
 * The broker is exercised against a FAKE upstream CDP endpoint — a plain Bun
 * websocket server that echoes commands back. No Chrome is required, and the
 * deny-list is proven end-to-end: a denied command must never reach upstream.
 */

interface FakeUpstream {
  url: string;
  received: Record<string, unknown>[];
  stop(): void;
}

function startFakeCdpUpstream(): FakeUpstream {
  const received: Record<string, unknown>[] = [];
  const server: Server<undefined> = Bun.serve<undefined>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("expected upgrade", { status: 400 });
    },
    websocket: {
      message(ws: ServerWebSocket<undefined>, message) {
        const text = typeof message === "string" ? message : message.toString();
        const command = JSON.parse(text) as Record<string, unknown>;
        received.push(command);
        ws.send(JSON.stringify({ id: command["id"], result: { method: command["method"] } }));
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}/devtools/browser/fake`,
    received,
    stop: () => server.stop(true),
  };
}

interface CdpFrame {
  id?: number;
  result?: { method?: string };
  error?: { code: number; message: string; data: string };
}

/** Open a client against the brokered URL and collect frames. */
async function connect(url: string): Promise<{
  send(frame: unknown): void;
  next(): Promise<CdpFrame>;
  close(): void;
}> {
  const socket = new WebSocket(url);
  const queue: CdpFrame[] = [];
  const waiters: ((f: CdpFrame) => void)[] = [];
  socket.addEventListener("message", (ev: MessageEvent) => {
    const frame = JSON.parse(String(ev.data)) as CdpFrame;
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(frame);
    else queue.push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("client socket failed to open")));
  });
  return {
    send: (frame: unknown) => socket.send(JSON.stringify(frame)),
    next: () =>
      new Promise<CdpFrame>((resolve) => {
        const queued = queue.shift();
        if (queued !== undefined) resolve(queued);
        else waiters.push(resolve);
      }),
    close: () => socket.close(),
  };
}

describe("CDP broker", () => {
  let upstream: FakeUpstream;
  let denials: CdpBrokerDenial[];
  let broker: CdpBroker;

  beforeEach(() => {
    upstream = startFakeCdpUpstream();
    denials = [];
    broker = createCdpBroker({
      sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      upstreamWsUrl: upstream.url,
      onDenied: (d) => denials.push(d),
    });
  });

  afterEach(async () => {
    await broker.close();
    upstream.stop();
  });

  test("hands out a brokered loopback URL, never the pod endpoint", () => {
    expect(broker.wsUrl).toStartWith("ws://127.0.0.1:");
    expect(broker.wsUrl).toContain("/cdp/01ARZ3NDEKTSV4RRFFQ69G5FAV?token=cdp_");
    expect(broker.wsUrl).not.toContain(String(new URL(upstream.url).port));
  });

  test("allow-listed commands reach the browser and results come back", async () => {
    const client = await connect(broker.wsUrl);
    client.send({ id: 1, method: "Page.navigate", params: { url: "https://example.com" } });
    const frame = await client.next();
    expect(frame).toEqual({ id: 1, result: { method: "Page.navigate" } });
    expect(upstream.received.map((c) => c["method"])).toEqual(["Page.navigate"]);
    client.close();
  });

  test("cookie reads are answered with a CDP error and NEVER forwarded", async () => {
    const client = await connect(broker.wsUrl);
    client.send({ id: 7, method: "Network.getAllCookies" });
    const frame = await client.next();
    expect(frame.id).toBe(7);
    expect(frame.result).toBeUndefined();
    expect(frame.error?.data).toBe("denied_method");
    expect(frame.error?.message).toContain("Network.getAllCookies");
    expect(upstream.received).toEqual([]);
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({
      sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      method: "Network.getAllCookies",
      rule: "denied_method",
    });
    client.close();
  });

  test("document.cookie scripting is refused too, and the channel stays usable", async () => {
    const client = await connect(broker.wsUrl);
    client.send({ id: 2, method: "Runtime.evaluate", params: { expression: "document.cookie" } });
    const denied = await client.next();
    expect(denied.error?.data).toBe("denied_script");

    client.send({ id: 3, method: "Runtime.evaluate", params: { expression: "location.href" } });
    const allowed = await client.next();
    expect(allowed).toEqual({ id: 3, result: { method: "Runtime.evaluate" } });
    expect(upstream.received.map((c) => c["id"])).toEqual([3]);
    client.close();
  });

  test("non-allow-listed methods are refused without an upstream hop", async () => {
    const client = await connect(broker.wsUrl);
    client.send({ id: 9, method: "Debugger.enable" });
    const frame = await client.next();
    expect(frame.error?.data).toBe("not_allow_listed");
    expect(upstream.received).toEqual([]);
    client.close();
  });

  test("the broker token is single-use", async () => {
    const first = await connect(broker.wsUrl);
    expect(broker.redeemed).toBe(true);
    const rejected = await fetch(broker.wsUrl.replace("ws://", "http://"));
    expect(rejected.status).toBe(401);
    first.close();
  });

  test("a wrong token is refused before any upstream connection", async () => {
    const bad = broker.wsUrl.replace(/token=.*$/, "token=cdp_forged");
    const rejected = await fetch(bad.replace("ws://", "http://"));
    expect(rejected.status).toBe(401);
    expect(upstream.received).toEqual([]);
  });

  test("frames with no method name are refused, not passed through", async () => {
    const client = await connect(broker.wsUrl);
    client.send({ id: 11, params: { url: "https://example.com" } });
    const frame = await client.next();
    expect(frame.id).toBe(11);
    expect(frame.error?.data).toBe("not_allow_listed");
    expect(upstream.received).toEqual([]);
    client.close();
  });
});
