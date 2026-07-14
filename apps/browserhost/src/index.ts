import { z } from "zod";
import type { Ulid } from "@lithis/core";
import { stubService } from "@lithis/stubkit";

/**
 * @lithis/browserhost — headed-Chrome session pods.
 *
 * Sealed browser-session credentials are custody assets mounted ONLY into
 * these pods; agents drive Chrome through a brokered CDP endpoint and never
 * see cookie material. Humanization is timing-only, and CAPTCHAs pause the
 * session and notify a human — they are never auto-solved.
 */

/**
 * Timing-only humanization policy — REAL config, zod-validated. This is the
 * whole humanization surface: pacing. No synthetic mouse curves, no
 * fingerprint spoofing, and `captcha` is a literal: pause + notify a human.
 */
export const humanizationPolicySchema = z
  .object({
    /** Minimum delay between actions, in milliseconds. */
    minDelayMs: z.number().int().nonnegative(),
    /** Uniform random jitter added on top of minDelayMs. */
    jitterMs: z.number().int().nonnegative(),
    /** Hard hourly cap on actions per mounted session. */
    maxActionsPerHour: z.number().int().positive(),
    /** [min, max] dwell time on a page before the next action, in milliseconds. */
    dwellMsRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
    /** The only supported CAPTCHA behavior — lithis never auto-solves. */
    captcha: z.literal("pause_and_notify"),
  })
  .refine((p) => p.dwellMsRange[0] <= p.dwellMsRange[1], {
    message: "dwellMsRange must be [min, max] with min <= max",
    path: ["dwellMsRange"],
  });
export type HumanizationPolicy = z.infer<typeof humanizationPolicySchema>;

/** Conservative shipped default: slow, bounded, human-paced. */
export const defaultHumanizationPolicy: HumanizationPolicy = humanizationPolicySchema.parse({
  minDelayMs: 1_200,
  jitterMs: 2_500,
  maxActionsPerHour: 40,
  dwellMsRange: [2_000, 15_000],
  captcha: "pause_and_notify",
});

/** A mounted (unsealed-into-pod) browser session. */
export interface BrowserSessionHandle {
  sessionId: Ulid;
  /** Credential the profile was unsealed from — for re-sealing on release. */
  credentialRef: Ulid;
}

/** Brokered CDP attachment — scoped, capability-checked, event-emitting. */
export interface CdpAttachment {
  sessionId: Ulid;
  /** Brokered DevTools websocket URL — never the pod's raw CDP endpoint. */
  wsUrl: string;
}

/** The pod runtime the server's custody + agents modules program against. */
export interface BrowserHostService {
  /** Unseal a custody browser_session credential into a fresh headed-Chrome pod. */
  mountSession(credentialRef: Ulid): Promise<BrowserSessionHandle>;
  /** Attach to a mounted session via the CDP broker. */
  attach(sessionId: Ulid): Promise<CdpAttachment>;
  /** Re-seal the profile back into custody and tear the pod down. */
  release(sessionId: Ulid): Promise<void>;
  /** The humanization policy this host enforces on every attached session. */
  policy(): HumanizationPolicy;
}

/** Pod runtime not implemented in the skeleton — every method throws. */
export function createBrowserHostService(): BrowserHostService {
  return stubService<BrowserHostService>(
    "browserhost.host",
    ["mountSession", "attach", "release", "policy"],
    "LITHIS-STUB: headed-Chrome session pods (custody profile mount, CDP broker, humanized pacing) not implemented — build-out phase 7",
  );
}
