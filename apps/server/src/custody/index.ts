import type { Credential, IsoDateTime, PrincipalContext, Ref, Ulid } from "@lithis/core";
import type { Db } from "../db";
import type { EventSpine } from "../spine";
import { createCustodyBroker } from "./broker";
import type { BrowserProfileStore } from "./browserprofiles";
import { createEnvFileBackend } from "./envfile";
import { createMountSession, createReleaseSession } from "./mount";
import type { BrowserHostPort } from "./mount";

/**
 * custody — the credential broker. Agents NEVER see raw secrets: they get
 * short-lived brokered handles; browser sessions are sealed profiles mounted
 * only into browserhost pods (cookies never enter agent context). Secret
 * material lives in the custody backend (env-file locally, Secret Manager on
 * the GCP reference deploy).
 *
 * Real as of P3-connect: getBrokered/issueFor/redeem over the env-file
 * backend. Real as of P12-browser: mountSession over the custody browser
 * profile store + an injected BrowserHostPort (custody never imports
 * apps/browserhost internals).
 */

export type CredentialRef = Ulid;

/**
 * A short-lived, capability-scoped handle. The raw secret stays inside the
 * custody adapter — connectors exchange this handle for authenticated calls.
 */
export interface BrokeredAuth {
  credentialId: Ulid;
  kind: Credential["kind"];
  /** Opaque broker token the connector runtime redeems; never the secret itself. */
  brokerToken: string;
  expiresAt: IsoDateTime;
}

export interface BrowserHostRef {
  /** The browserhost pod the sealed profile is mounted into. */
  podId: string;
}

export interface SessionMount {
  credentialId: Ulid;
  /** The browserhost-assigned session id — release()/attach() key off this. */
  sessionId: Ulid;
  host: BrowserHostRef;
  /** BROKERED CDP url (single-use token) — never the pod's raw DevTools endpoint. */
  cdpUrl: string;
  mountedAt: IsoDateTime;
}

export interface Custody {
  getBrokered(ref: CredentialRef, p: PrincipalContext): Promise<BrokeredAuth>;
  /**
   * Unseal a `browser_session` credential into a browserhost pod. The pod is
   * the injected BrowserHostPort — callers no longer name one (the P3-era
   * `host: BrowserHostRef` argument was always vestigial; the pod that
   * actually served the mount comes back on the SessionMount).
   */
  mountSession(ref: CredentialRef, p: PrincipalContext): Promise<SessionMount>;
}

/** What redeeming a brokerToken yields — server-side connector-runtime use ONLY; never log or serialize. */
export interface RedeemedSecret {
  credentialId: Ulid;
  kind: Credential["kind"];
  secret: string;
}

/** Credential-record lookup — the connections module's directory satisfies this. */
export interface CredentialLookup {
  get(credentialId: Ulid): Promise<Credential | null>;
}

/** Where secret MATERIAL lives (env-file locally, Secret Manager on GCP). */
export interface CustodyBackend {
  /** Resolve a custodyBackendRef (e.g. "env-file:SLACK_BOT_TOKEN") to its secret. */
  getSecret(custodyBackendRef: string): Promise<string>;
}

export interface CustodyDeps {
  db: Db;
  spine: EventSpine;
  credentials: CredentialLookup;
  backend: CustodyBackend;
  /**
   * Where SEALED browser profiles live. Absent → mountSession fails with a
   * clear configuration error (honest degrade, not a stub: browser sessions
   * are simply not configured on this deployment).
   */
  profiles?: BrowserProfileStore;
  /** The browserhost pod runtime. Absent → mountSession fails the same way. */
  browserHost?: BrowserHostPort;
  /** Broker token time-to-live in ms (default 15 minutes). */
  ttlMs?: number;
  /** Injectable clock for expiry tests. */
  nowMs?: () => number;
}

/** The server-internal face: issuance for non-principal actors + token redemption. */
export interface CustodyRuntime extends Custody {
  /** Issue a BrokeredAuth on behalf of any actor Ref (e.g. a connection during a scheduled sync). */
  issueFor(credentialId: CredentialRef, tenantId: Ulid, actor: Ref): Promise<BrokeredAuth>;
  /** Exchange a live brokerToken for the secret material — in-process, connector-runtime only. */
  redeem(brokerToken: string): Promise<RedeemedSecret>;
  /** Re-seal a mounted browser session and tear its pod down. */
  releaseSession(sessionId: Ulid, credentialRef: CredentialRef, p: PrincipalContext): Promise<void>;
}

/**
 * Honest CONFIG degrade (the context-store precedent): a deployment without a
 * browser profile store or a browserhost pod cannot mount sealed sessions, and
 * says so. Not a stub — the real implementation lives in ./mount.ts and is
 * wired whenever both seams are supplied.
 */
function unconfiguredBrowserSessions(): never {
  throw new Error(
    "sealed browser sessions unavailable: this server was built without a browser profile store " +
      "and/or a browserhost pod (set LITHIS_BROWSER_PROFILE_DIR and wire @lithis/browserhost)",
  );
}

export function createCustody(deps: CustodyDeps): CustodyRuntime {
  const browserSessionsConfigured =
    deps.profiles !== undefined && deps.browserHost !== undefined;
  const mountDeps = browserSessionsConfigured
    ? {
        db: deps.db,
        spine: deps.spine,
        credentials: deps.credentials,
        profiles: deps.profiles!,
        browserHost: deps.browserHost!,
      }
    : undefined;
  return createCustodyBroker(deps, {
    mountSession:
      mountDeps !== undefined ? createMountSession(mountDeps) : unconfiguredBrowserSessions,
    releaseSession:
      mountDeps !== undefined ? createReleaseSession(mountDeps) : unconfiguredBrowserSessions,
  });
}

export { createEnvFileBackend };
export {
  BROWSER_PROFILE_REF_PREFIX,
  DEFAULT_BROWSER_PROFILE_DIR,
  createLocalBrowserProfileStore,
  profileKeyFromRef,
} from "./browserprofiles";
export type { BrowserProfileStore } from "./browserprofiles";
export { NotABrowserSessionError } from "./mount";
export type { BrowserHostPort } from "./mount";
