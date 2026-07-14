import type { Credential, IsoDateTime, PrincipalContext, Ulid } from "@lithis/core";
import { stubService } from "@lithis/stubkit";

/**
 * custody — the credential broker. Agents NEVER see raw secrets: they get
 * short-lived brokered handles; browser sessions are sealed profiles mounted
 * only into browserhost pods (cookies never enter agent context). Secret
 * material lives in the custody backend (env-file locally, Secret Manager on
 * the GCP reference deploy).
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

const custody = stubService<Custody>(
  "server.custody.broker",
  ["getBrokered", "mountSession"],
  "LITHIS-STUB: credential brokering + sealed browser-session mounting not implemented",
);

export function createCustody(): Custody {
  return custody;
}
