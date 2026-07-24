import { z } from "zod";
import { connectCdp } from "./cdp";
import type { CdpConnectOptions, CdpTransport } from "./cdp";

/**
 * Browser toolkit — the typed surface connectors and skills use to drive a
 * headed-Chrome session in an `apps/browserhost` pod. Sessions are sealed
 * custody assets (cookies never enter agent context); every action is a
 * capability-checked spine event upstream.
 *
 * REAL as of P12-browser: the action contracts, PaceGuard (timing-only
 * humanization — the crm lesson: pace like a person, never fake identity), and
 * the session client itself, speaking CDP over Bun's built-in WebSocket
 * against the BROKERED endpoint browserhost hands out. What the wire will
 * carry is the broker's decision, not this client's.
 */

export const browserActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), url: z.string().url() }),
  z.object({
    kind: z.literal("extract"),
    /** Shared selector definitions live in packs (e.g. linkedin-bd). */
    selector: z.string().min(1),
    attribute: z.string().optional(),
  }),
  z.object({ kind: z.literal("click"), selector: z.string().min(1) }),
  /** CAPTCHA = pause + notify a human, NEVER solve. */
  z.object({ kind: z.literal("captcha_pause"), reason: z.string().min(1) }),
]);
export type BrowserAction = z.infer<typeof browserActionSchema>;

/**
 * Screenshot evidence is split in two on purpose:
 *
 * - the SDK has NO blob store, so a client-side capture comes back raw in
 *   `screenshotBase64`;
 * - the SERVER-side caller (connector act / the action-intent executor)
 *   persists those bytes through the context store and fills
 *   `screenshotBlobId` on the receipt it records.
 *
 * A skill or connector running client-side therefore never invents a blob id,
 * and the blob id on an Evidence row always points at a real stored capture.
 */
export interface BrowserActionResult {
  ok: boolean;
  /** Text/attribute payload for extract actions. */
  extracted?: string;
  /** Raw page capture (base64 PNG) — the server-side caller persists it. */
  screenshotBase64?: string;
  /** Page-capture evidence blob, filled in server-side after persistence. */
  screenshotBlobId?: string;
  detail?: string;
}

export interface BrowserSession {
  /** The custody SessionMount this client is bound to. */
  mountRef: string;
  perform(action: BrowserAction): Promise<BrowserActionResult>;
  currentUrl(): Promise<string>;
  close(): Promise<void>;
}

export interface PaceGuardOptions {
  /** Hard floor between consecutive actions. */
  minDelayMs: number;
  /** Uniform random extra delay in [0, jitterMs). */
  jitterMs: number;
  /** Sliding-window hourly action cap. */
  maxPerHour: number;
  /** Inject a seeded generator for deterministic tests. Defaults to Math.random. */
  rand?: () => number;
  /** Inject a clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

const HOUR_MS = 3_600_000;

/**
 * Token-bucket pacing for browser automation. Fully implemented (pure logic):
 * `nextDelay()` says how long to wait before the next action, honoring both
 * the min+jitter spacing and the sliding hourly cap; `recordAction()` marks
 * an action as performed now.
 */
export class PaceGuard {
  private readonly minDelayMs: number;
  private readonly jitterMs: number;
  private readonly maxPerHour: number;
  private readonly rand: () => number;
  private readonly clock: () => number;
  private actionTimes: number[] = [];

  constructor(options: PaceGuardOptions) {
    if (!Number.isFinite(options.minDelayMs) || options.minDelayMs < 0) {
      throw new RangeError("PaceGuard: minDelayMs must be >= 0");
    }
    if (!Number.isFinite(options.jitterMs) || options.jitterMs < 0) {
      throw new RangeError("PaceGuard: jitterMs must be >= 0");
    }
    if (!Number.isInteger(options.maxPerHour) || options.maxPerHour < 1) {
      throw new RangeError("PaceGuard: maxPerHour must be a positive integer");
    }
    this.minDelayMs = options.minDelayMs;
    this.jitterMs = options.jitterMs;
    this.maxPerHour = options.maxPerHour;
    this.rand = options.rand ?? Math.random;
    this.clock = options.now ?? Date.now;
  }

  /** Actions recorded within the trailing hour. */
  get actionsInWindow(): number {
    this.prune(this.clock());
    return this.actionTimes.length;
  }

  /**
   * Milliseconds to wait, from now, before performing the next action.
   * Consumes one draw from `rand` (jitter), so seeded guards are deterministic
   * per call sequence. Returns 0 when the action may go immediately.
   */
  nextDelay(): number {
    const now = this.clock();
    this.prune(now);
    const jitter = this.jitterMs === 0 ? 0 : Math.floor(this.rand() * this.jitterMs);

    // Spacing constraint: last action + minDelay + jitter.
    let earliest = now;
    const last = this.actionTimes[this.actionTimes.length - 1];
    if (last !== undefined) {
      earliest = Math.max(earliest, last + this.minDelayMs + jitter);
    }

    // Hourly cap: the oldest action in the window must age out first.
    if (this.actionTimes.length >= this.maxPerHour) {
      const index = this.actionTimes.length - this.maxPerHour;
      const gatingAction = this.actionTimes[index];
      if (gatingAction !== undefined) {
        earliest = Math.max(earliest, gatingAction + HOUR_MS);
      }
    }

    return Math.max(0, earliest - now);
  }

  /** Record that an action was just performed. */
  recordAction(): void {
    const now = this.clock();
    this.actionTimes.push(now);
    this.prune(now);
  }

  private prune(now: number): void {
    const cutoff = now - HOUR_MS;
    while (this.actionTimes.length > 0 && (this.actionTimes[0] ?? Infinity) <= cutoff) {
      this.actionTimes.shift();
    }
  }
}

// ── the live session client ─────────────────────────────────────────────────

/**
 * The pacing knobs a host policy contributes. Structurally satisfied by
 * @lithis/browserhost's HumanizationPolicy, without the SDK depending on it.
 */
export interface BrowserPacingPolicy {
  minDelayMs: number;
  jitterMs: number;
  maxActionsPerHour: number;
}

/**
 * What custody's SessionMount + browserhost's policy() give a caller. The
 * mountRef alone is not enough to open a socket — the brokered URL is minted
 * per attach and is single-use, so it always travels with the mount.
 */
export interface BrowserSessionTarget {
  /** The custody SessionMount id (audit correlation). */
  mountRef: string;
  /** BROKERED CDP websocket url from browserhost attach(). Never a raw pod endpoint. */
  cdpUrl: string;
  /** The host's humanization policy — drives the PaceGuard. */
  policy: BrowserPacingPolicy;
}

export interface OpenBrowserSessionOptions extends CdpConnectOptions {
  /** Capture a screenshot after every action (evidence for outreach acts). */
  captureScreenshots?: boolean;
  /** How long to wait for a page load after navigate (default 30s). */
  navigationTimeoutMs?: number;
  /** Injectable sleep for deterministic pacing tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source (PaceGuard). */
  rand?: () => number;
  /** Injectable clock (PaceGuard). */
  now?: () => number;
  /** Injectable transport — tests script a fake CDP endpoint. */
  transport?: CdpTransport;
}

function evaluateExpression(selector: string, attribute?: string): string {
  const sel = JSON.stringify(selector);
  const attr = attribute === undefined ? "null" : JSON.stringify(attribute);
  return (
    `(() => { const el = document.querySelector(${sel});` +
    ` if (el === null) return { found: false };` +
    ` const attr = ${attr};` +
    ` const value = attr === null ? (el.textContent ?? "") : (el.getAttribute(attr) ?? "");` +
    ` return { found: true, value: String(value).trim() }; })()`
  );
}

function clickExpression(selector: string): string {
  const sel = JSON.stringify(selector);
  return (
    `(() => { const el = document.querySelector(${sel});` +
    ` if (el === null) return { found: false };` +
    ` el.scrollIntoView({ block: "center" }); el.click();` +
    ` return { found: true }; })()`
  );
}

interface EvaluateOutcome {
  found?: boolean;
  value?: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Open a live browser session against a custody-mounted profile in a
 * browserhost pod. Every action is paced through a PaceGuard built from the
 * host's policy — pacing is the entire humanization surface, and CAPTCHAs are
 * never solved (see the `captcha_pause` branch).
 */
export async function openBrowserSession(
  target: BrowserSessionTarget,
  opts: OpenBrowserSessionOptions = {},
): Promise<BrowserSession> {
  const sleep = opts.sleep ?? defaultSleep;
  const navigationTimeoutMs = opts.navigationTimeoutMs ?? 30_000;
  const guard = new PaceGuard({
    minDelayMs: target.policy.minDelayMs,
    jitterMs: target.policy.jitterMs,
    maxPerHour: target.policy.maxActionsPerHour,
    ...(opts.rand !== undefined ? { rand: opts.rand } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });

  const cdp =
    opts.transport ??
    (await connectCdp(target.cdpUrl, {
      ...(opts.commandTimeoutMs !== undefined ? { commandTimeoutMs: opts.commandTimeoutMs } : {}),
      ...(opts.createSocket !== undefined ? { createSocket: opts.createSocket } : {}),
    }));

  // The broker fronts the pod's BROWSER-level endpoint, so reach a page target
  // (creating one when the pod has none) and speak to it via a flat session.
  const targets = (await cdp.send("Target.getTargets")) as {
    targetInfos?: { targetId: string; type: string }[];
  };
  let pageTargetId = targets.targetInfos?.find((t) => t.type === "page")?.targetId;
  if (pageTargetId === undefined) {
    const created = (await cdp.send("Target.createTarget", { url: "about:blank" })) as {
      targetId?: string;
    };
    pageTargetId = created.targetId;
  }
  if (pageTargetId === undefined) {
    throw new Error(
      `browser session ${target.mountRef}: the pod exposed no page target and none could be created`,
    );
  }
  const attached = (await cdp.send("Target.attachToTarget", {
    targetId: pageTargetId,
    flatten: true,
  })) as { sessionId?: string };
  const cdpSessionId = attached.sessionId;

  const send = (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> =>
    cdp.send(method, params, cdpSessionId);

  await send("Page.enable");
  await send("Runtime.enable");

  async function captureScreenshot(): Promise<string | undefined> {
    if (opts.captureScreenshots !== true) return undefined;
    const shot = (await send("Page.captureScreenshot", { format: "png" })) as { data?: string };
    return typeof shot.data === "string" ? shot.data : undefined;
  }

  async function evaluate(expression: string): Promise<EvaluateOutcome> {
    const response = (await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result?: { value?: EvaluateOutcome };
      exceptionDetails?: { text?: string };
    };
    if (response.exceptionDetails !== undefined) {
      throw new Error(
        `page evaluation threw: ${response.exceptionDetails.text ?? "unknown exception"}`,
      );
    }
    return response.result?.value ?? {};
  }

  async function navigate(url: string): Promise<BrowserActionResult> {
    const loaded = new Promise<void>((resolve) => {
      const off = cdp.on("Page.loadEventFired", () => {
        off();
        resolve();
      });
      setTimeout(() => {
        off();
        resolve();
      }, navigationTimeoutMs);
    });
    const result = (await send("Page.navigate", { url })) as { errorText?: string };
    if (typeof result.errorText === "string" && result.errorText.length > 0) {
      return { ok: false, detail: `navigation to ${url} failed: ${result.errorText}` };
    }
    await loaded;
    return { ok: true, detail: `navigated to ${url}` };
  }

  async function performAction(action: BrowserAction): Promise<BrowserActionResult> {
    switch (action.kind) {
      case "navigate":
        return navigate(action.url);
      case "extract": {
        const outcome = await evaluate(evaluateExpression(action.selector, action.attribute));
        if (outcome.found !== true) {
          return { ok: false, detail: `no element matched selector ${action.selector}` };
        }
        return { ok: true, extracted: outcome.value ?? "" };
      }
      case "click": {
        const outcome = await evaluate(clickExpression(action.selector));
        if (outcome.found !== true) {
          return { ok: false, detail: `no element matched selector ${action.selector}` };
        }
        return { ok: true, detail: `clicked ${action.selector}` };
      }
      case "captcha_pause":
        // NEVER solved, never worked around, never retried: the caller raises
        // a HumanRequest and a person finishes it in the headed browser.
        return {
          ok: false,
          detail:
            `captcha_pause: ${action.reason} — lithis never solves CAPTCHAs; ` +
            `raise a HumanRequest and let a person complete it in the pod`,
        };
    }
  }

  return {
    mountRef: target.mountRef,

    async perform(action: BrowserAction): Promise<BrowserActionResult> {
      const parsed = browserActionSchema.parse(action);
      // A paused CAPTCHA is not a browser action: it consumes no pacing budget
      // and touches no page.
      if (parsed.kind === "captcha_pause") return performAction(parsed);

      await sleep(guard.nextDelay());
      const result = await performAction(parsed);
      guard.recordAction();
      const screenshotBase64 = await captureScreenshot();
      return {
        ...result,
        ...(screenshotBase64 !== undefined ? { screenshotBase64 } : {}),
      };
    },

    async currentUrl(): Promise<string> {
      const outcome = await evaluate(
        `(() => ({ found: true, value: String(location.href) }))()`,
      );
      return outcome.value ?? "";
    },

    async close(): Promise<void> {
      await cdp.close();
    },
  };
}

export { connectCdp, CdpError } from "./cdp";
export type { CdpConnectOptions, CdpEventFrame, CdpTransport } from "./cdp";
