import type { Ulid } from "@lithis/core";
import { createRealBrowserHostService } from "./host";
import type { BrowserHostDeps } from "./host";
import type { HumanizationPolicy } from "./policy";

/**
 * @lithis/browserhost — headed-Chrome session pods.
 *
 * Sealed browser-session credentials are custody assets mounted ONLY into
 * these pods; agents drive Chrome through a brokered CDP endpoint and never
 * see cookie material. Humanization is timing-only, and CAPTCHAs pause the
 * session and notify a human — they are never auto-solved.
 *
 * REAL as of P12-browser: the pod runtime (host.ts — unseal → launch →
 * broker → re-seal), the Chrome process seam (launcher.ts), the CDP broker
 * (broker.ts) and its allow/deny policy (cdp-policy.ts). Object-storage-backed
 * profile sealing lands with the GCP deploy (P15); today custody hands the pod
 * a local sealed-profile directory.
 */

/** A mounted (unsealed-into-pod) browser session. */
export interface BrowserSessionHandle {
  sessionId: Ulid;
  /** Credential the profile was unsealed from — for re-sealing on release. */
  credentialRef: Ulid;
  /** The pod this session is resident in. */
  podId: string;
}

/**
 * What custody hands the pod to mount a session. The pod never resolves
 * credentials itself: custody owns the credential → sealed-profile mapping
 * (see apps/server/src/custody/browserprofiles.ts) and the pod owns the
 * unseal/re-seal mechanics.
 */
export interface MountRequest {
  credentialRef: Ulid;
  /** Directory holding the SEALED profile. Copied in on mount, back out on release. */
  sealedProfileDir: string;
}

/** Brokered CDP attachment — scoped, capability-checked, event-emitting. */
export interface CdpAttachment {
  sessionId: Ulid;
  /** Brokered DevTools websocket URL — never the pod's raw CDP endpoint. */
  wsUrl: string;
}

/** The pod runtime the server's custody + agents modules program against. */
export interface BrowserHostService {
  /** This pod's identifier, reported back to custody on every mount. */
  podId: string;
  /** Unseal a custody browser_session credential into a fresh headed-Chrome pod. */
  mountSession(request: MountRequest): Promise<BrowserSessionHandle>;
  /** Attach to a mounted session via the CDP broker (single-use brokered URL). */
  attach(sessionId: Ulid): Promise<CdpAttachment>;
  /** Re-seal the profile back into custody and tear the pod down. */
  release(sessionId: Ulid): Promise<void>;
  /** The humanization policy this host enforces on every attached session. */
  policy(): HumanizationPolicy;
}

/**
 * Build the pod runtime. `deps.launcher` is the only mandatory piece — pass
 * createSystemChromeLauncher() in production, a fake in tests (the suite never
 * requires a real browser).
 */
export function createBrowserHostService(deps: BrowserHostDeps): BrowserHostService {
  return createRealBrowserHostService(deps);
}

export { defaultHumanizationPolicy, humanizationPolicySchema } from "./policy";
export type { HumanizationPolicy } from "./policy";
export { UnknownSessionError } from "./host";
export type { BrowserHostDeps, BrowserHostEvent } from "./host";
export {
  CHROME_BINARY_ENV,
  DEFAULT_CHROME_BINARIES,
  chromeLaunchArgs,
  createSystemChromeLauncher,
  parseDevToolsEndpoint,
  resolveChromeBinary,
} from "./launcher";
export type { ChromeLaunchHandle, ChromeLauncher } from "./launcher";
export { createCdpBroker } from "./broker";
export type { CdpBroker, CdpBrokerDenial, CdpBrokerOptions } from "./broker";
export {
  CDP_ALLOWED_METHODS,
  CDP_DENIED_DOMAINS,
  CDP_DENIED_METHODS,
  cdpDenialError,
  decideCdpCommand,
  decideCdpMethod,
} from "./cdp-policy";
export type { CdpCommand, CdpDecision, CdpDenyRule } from "./cdp-policy";
