import type { Credential, IsoDateTime, PrincipalContext, Ref, Ulid } from "@lithis/core";
import { stub } from "@lithis/stubkit";
import type { Db } from "../db";
import type { EventSpine } from "../spine";
import { createCustodyBroker } from "./broker";
import { createEnvFileBackend } from "./envfile";

/**
 * custody — the credential broker. Agents NEVER see raw secrets: they get
 * short-lived brokered handles; browser sessions are sealed profiles mounted
 * only into browserhost pods (cookies never enter agent context). Secret
 * material lives in the custody backend (env-file locally, Secret Manager on
 * the GCP reference deploy).
 *
 * Real as of P3-connect: getBrokered/issueFor/redeem over the env-file
 * backend. mountSession stays a loud stub until the browserhost lands (P12).
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
  host: BrowserHostRef;
  /** CDP endpoint the broker exposes to the pod — profile bytes stay sealed. */
  cdpUrl: string;
  mountedAt: IsoDateTime;
}

export interface Custody {
  getBrokered(ref: CredentialRef, p: PrincipalContext): Promise<BrokeredAuth>;
  mountSession(ref: CredentialRef, host: BrowserHostRef): Promise<SessionMount>;
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
}

const mountSession = stub<Custody["mountSession"]>(
  "server.custody.broker.mountSession",
  "LITHIS-STUB: sealed browser-session mounting not implemented — browser_session credentials mount only into browserhost pods (P12-browser)",
);

export function createCustody(deps: CustodyDeps): CustodyRuntime {
  return createCustodyBroker(deps, mountSession);
}

export { createEnvFileBackend };
