import { describe, expect, test } from "bun:test";
import { browserActionSchema, openBrowserSession, PaceGuard } from "../src/browser";
import type { BrowserPacingPolicy } from "../src/browser";
import type { CdpEventFrame, CdpTransport } from "../src/cdp";

/** Deterministic rand: yields the given values in order, then repeats the last. */
function seededRand(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

describe("browserActionSchema", () => {
  test("parses each action contract", () => {
    expect(
      browserActionSchema.parse({ kind: "navigate", url: "https://example.com/login" }).kind,
    ).toBe("navigate");
    expect(
      browserActionSchema.parse({ kind: "extract", selector: ".profile-name" }).kind,
    ).toBe("extract");
    expect(browserActionSchema.parse({ kind: "click", selector: "#connect" }).kind).toBe("click");
    expect(
      browserActionSchema.parse({ kind: "captcha_pause", reason: "checkpoint page detected" })
        .kind,
    ).toBe("captcha_pause");
  });

  test("rejects a navigate with a non-URL and an unknown kind", () => {
    expect(() => browserActionSchema.parse({ kind: "navigate", url: "not a url" })).toThrow();
    expect(() => browserActionSchema.parse({ kind: "solve_captcha", token: "x" })).toThrow();
  });
});

describe("PaceGuard", () => {
  test("first action may go immediately", () => {
    const guard = new PaceGuard({ minDelayMs: 1000, jitterMs: 500, maxPerHour: 10 });
    expect(guard.nextDelay()).toBe(0);
  });

  test("enforces minDelay + jitter spacing after an action (deterministic)", () => {
    let now = 0;
    const guard = new PaceGuard({
      minDelayMs: 500,
      jitterMs: 1000,
      maxPerHour: 100,
      rand: seededRand([0.9, 0.1]),
      now: () => now,
    });
    guard.recordAction(); // at t=0
    expect(guard.nextDelay()).toBe(500 + 900); // jitter draw 0.9 → 900
    expect(guard.nextDelay()).toBe(500 + 100); // jitter draw 0.1 → 100
    now = 550;
    expect(guard.nextDelay()).toBe(500 + 100 - 550); // partial wait elapsed
  });

  test("two guards with the same seed and clock behave identically", () => {
    const build = () => {
      let now = 0;
      const guard = new PaceGuard({
        minDelayMs: 250,
        jitterMs: 400,
        maxPerHour: 5,
        rand: seededRand([0.5, 0.25, 0.75]),
        now: () => now,
      });
      const observed: number[] = [];
      guard.recordAction();
      observed.push(guard.nextDelay());
      now = 300;
      guard.recordAction();
      observed.push(guard.nextDelay(), guard.nextDelay());
      return observed;
    };
    expect(build()).toEqual(build());
  });

  test("hourly cap gates on the oldest action in the window", () => {
    let now = 0;
    const guard = new PaceGuard({
      minDelayMs: 1000,
      jitterMs: 0,
      maxPerHour: 2,
      now: () => now,
    });
    guard.recordAction(); // t=0
    now = 1000;
    guard.recordAction(); // t=1000
    now = 2000;
    // Spacing is satisfied (last + 1000 = 2000), but 2 actions sit in the window:
    // the t=0 action must age out at t=3_600_000.
    expect(guard.nextDelay()).toBe(3_600_000 - 2000);
  });

  test("actions age out of the sliding window", () => {
    let now = 0;
    const guard = new PaceGuard({ minDelayMs: 0, jitterMs: 0, maxPerHour: 2, now: () => now });
    guard.recordAction(); // t=0
    now = 1000;
    guard.recordAction(); // t=1000
    expect(guard.actionsInWindow).toBe(2);
    now = 3_600_001; // t=0 action is now outside the window
    expect(guard.actionsInWindow).toBe(1);
    expect(guard.nextDelay()).toBe(0);
  });

  test("rejects nonsense construction", () => {
    expect(() => new PaceGuard({ minDelayMs: -1, jitterMs: 0, maxPerHour: 1 })).toThrow(
      RangeError,
    );
    expect(() => new PaceGuard({ minDelayMs: 0, jitterMs: -5, maxPerHour: 1 })).toThrow(
      RangeError,
    );
    expect(() => new PaceGuard({ minDelayMs: 0, jitterMs: 0, maxPerHour: 0 })).toThrow(RangeError);
  });
});

// ── the live session client, over a scripted fake CDP transport ─────────────

const POLICY: BrowserPacingPolicy = { minDelayMs: 1_000, jitterMs: 500, maxActionsPerHour: 40 };

interface FakeCdp extends CdpTransport {
  calls: { method: string; params?: Record<string, unknown> }[];
  emit(frame: CdpEventFrame): void;
  closed: boolean;
}

/**
 * A scripted CDP endpoint: `responses` maps a method to what the browser
 * answers. Anything unscripted answers `{}` — the point of these tests is the
 * client's protocol behavior, not Chrome's.
 */
function fakeCdp(responses: Record<string, unknown> = {}): FakeCdp {
  const handlers = new Map<string, Set<(f: CdpEventFrame) => void>>();
  const fake: FakeCdp = {
    calls: [],
    closed: false,
    async send(method, params) {
      fake.calls.push({ method, ...(params !== undefined ? { params } : {}) });
      const scripted = responses[method];
      const value = typeof scripted === "function" ? (scripted as (p?: unknown) => unknown)(params) : scripted;
      return (value ?? {}) as Record<string, unknown>;
    },
    on(method, handler) {
      const set = handlers.get(method) ?? new Set();
      set.add(handler);
      handlers.set(method, set);
      return () => set.delete(handler);
    },
    emit(frame) {
      for (const h of handlers.get(frame.method) ?? []) h(frame);
    },
    async close() {
      fake.closed = true;
    },
  };
  return fake;
}

const PAGE_TARGETS = {
  "Target.getTargets": { targetInfos: [{ targetId: "page-1", type: "page" }] },
  "Target.attachToTarget": { sessionId: "cdp-session-1" },
};

async function openWith(
  responses: Record<string, unknown>,
  opts: { captureScreenshots?: boolean; sleeps?: number[] } = {},
): Promise<{ session: Awaited<ReturnType<typeof openBrowserSession>>; cdp: FakeCdp }> {
  const cdp = fakeCdp({ ...PAGE_TARGETS, ...responses });
  const session = await openBrowserSession(
    { mountRef: "mount-1", cdpUrl: "ws://127.0.0.1:1/cdp/x?token=t", policy: POLICY },
    {
      transport: cdp,
      rand: () => 0,
      now: () => 1_000_000,
      sleep: async (ms) => {
        opts.sleeps?.push(ms);
      },
      ...(opts.captureScreenshots === true ? { captureScreenshots: true } : {}),
    },
  );
  return { session, cdp };
}

describe("openBrowserSession", () => {
  test("attaches to a page target and enables the page/runtime domains", async () => {
    const { cdp } = await openWith({});
    expect(cdp.calls.map((c) => c.method)).toEqual([
      "Target.getTargets",
      "Target.attachToTarget",
      "Page.enable",
      "Runtime.enable",
    ]);
  });

  test("creates a page target when the pod has none", async () => {
    const cdp = fakeCdp({
      "Target.getTargets": { targetInfos: [] },
      "Target.createTarget": { targetId: "page-new" },
      "Target.attachToTarget": { sessionId: "s" },
    });
    await openBrowserSession(
      { mountRef: "m", cdpUrl: "ws://x", policy: POLICY },
      { transport: cdp, sleep: async () => {} },
    );
    expect(cdp.calls.map((c) => c.method)).toContain("Target.createTarget");
  });

  test("navigate waits for the load event", async () => {
    const { session, cdp } = await openWith({ "Page.navigate": { frameId: "f1" } });
    const done = session.perform({ kind: "navigate", url: "https://example.com/" });
    // The client is waiting on Page.loadEventFired; fire it.
    await Bun.sleep(1);
    cdp.emit({ method: "Page.loadEventFired", params: {} });
    const result = await done;
    expect(result.ok).toBe(true);
    expect(cdp.calls.some((c) => c.method === "Page.navigate")).toBe(true);
  });

  test("navigation errors come back honestly, never as a silent success", async () => {
    const { session } = await openWith({ "Page.navigate": { errorText: "net::ERR_ABORTED" } });
    const result = await session.perform({ kind: "navigate", url: "https://example.com/" });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("net::ERR_ABORTED");
  });

  test("extract returns the element's text, or ok:false when nothing matches", async () => {
    const found = await openWith({
      "Runtime.evaluate": { result: { value: { found: true, value: "Jane Roe" } } },
    });
    expect(await found.session.perform({ kind: "extract", selector: ".name" })).toEqual({
      ok: true,
      extracted: "Jane Roe",
    });

    const missing = await openWith({
      "Runtime.evaluate": { result: { value: { found: false } } },
    });
    const result = await missing.session.perform({ kind: "extract", selector: ".name" });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(".name");
  });

  test("extract passes the attribute through to the page expression", async () => {
    const { session, cdp } = await openWith({
      "Runtime.evaluate": { result: { value: { found: true, value: "/in/jane" } } },
    });
    await session.perform({ kind: "extract", selector: "a.profile", attribute: "href" });
    const evaluate = cdp.calls.find((c) => c.method === "Runtime.evaluate");
    expect(String(evaluate?.params?.["expression"])).toContain('"href"');
    expect(String(evaluate?.params?.["expression"])).toContain('"a.profile"');
  });

  test("click reports a missing element instead of pretending it clicked", async () => {
    const { session } = await openWith({
      "Runtime.evaluate": { result: { value: { found: false } } },
    });
    const result = await session.perform({ kind: "click", selector: "#connect" });
    expect(result.ok).toBe(false);
  });

  test("captcha_pause NEVER solves: ok:false, reason carried, no page touched", async () => {
    const { session, cdp } = await openWith({});
    const before = cdp.calls.length;
    const result = await session.perform({
      kind: "captcha_pause",
      reason: "challenge interstitial on /search",
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("challenge interstitial on /search");
    expect(result.detail).toContain("never solves CAPTCHAs");
    expect(cdp.calls.length).toBe(before);
  });

  test("actions are paced through the PaceGuard from the host policy", async () => {
    const sleeps: number[] = [];
    const { session } = await openWith(
      { "Runtime.evaluate": { result: { value: { found: true, value: "x" } } } },
      { sleeps },
    );
    await session.perform({ kind: "extract", selector: ".a" });
    await session.perform({ kind: "extract", selector: ".b" });
    // First action goes immediately; the second waits minDelay (+0 jitter, rand=0).
    expect(sleeps).toEqual([0, 1_000]);
  });

  test("a paused captcha consumes no pacing budget", async () => {
    const sleeps: number[] = [];
    const { session } = await openWith({}, { sleeps });
    await session.perform({ kind: "captcha_pause", reason: "bot check" });
    expect(sleeps).toEqual([]);
  });

  test("screenshots come back raw — the SDK never invents a blob id", async () => {
    const { session } = await openWith(
      {
        "Runtime.evaluate": { result: { value: { found: true, value: "x" } } },
        "Page.captureScreenshot": { data: "iVBORw0KGgo=" },
      },
      { captureScreenshots: true },
    );
    const result = await session.perform({ kind: "extract", selector: ".a" });
    expect(result.screenshotBase64).toBe("iVBORw0KGgo=");
    expect(result.screenshotBlobId).toBeUndefined();
  });

  test("currentUrl reads location.href off the page", async () => {
    const { session } = await openWith({
      "Runtime.evaluate": { result: { value: { found: true, value: "https://example.com/x" } } },
    });
    expect(await session.currentUrl()).toBe("https://example.com/x");
  });

  test("close tears the transport down", async () => {
    const { session, cdp } = await openWith({});
    await session.close();
    expect(cdp.closed).toBe(true);
  });

  test("malformed actions are rejected by the contract before any CDP traffic", async () => {
    const { session } = await openWith({});
    await expect(
      session.perform({ kind: "navigate", url: "not-a-url" } as never),
    ).rejects.toThrow();
  });
});
