import { z } from "zod";
import { stub } from "@lithis/stubkit";

/**
 * Browser toolkit — the typed surface connectors and skills use to drive a
 * headed-Chrome session in an `apps/browserhost` pod. Sessions are sealed
 * custody assets (cookies never enter agent context); every action is a
 * capability-checked spine event upstream.
 *
 * REAL here: the action contracts and PaceGuard (timing-only humanization —
 * the crm lesson: pace like a person, never fake identity).
 * STUBBED here: the session client itself (CDP broker lives in browserhost).
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

export interface BrowserActionResult {
  ok: boolean;
  /** Text/attribute payload for extract actions. */
  extracted?: string;
  /** Page-capture evidence blob recorded by browserhost. */
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

/**
 * Open a browser session against a custody-mounted profile in a browserhost
 * pod. Stubbed: the CDP broker and pod topology live in apps/browserhost.
 */
export const openBrowserSession = stub<(mountRef: string) => Promise<BrowserSession>>(
  "sdk.browser.session",
  "LITHIS-STUB: browserhost CDP session client not implemented — sealed-profile pods land with the browserhost build-out",
);
