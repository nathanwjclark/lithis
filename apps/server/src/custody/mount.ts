import { nowIso } from "@lithis/core";
import type { Credential, PrincipalContext, Ulid } from "@lithis/core";
import type { Db } from "../db";
import type { EventSpine } from "../spine";
import type { BrowserProfileStore } from "./browserprofiles";
import type { CredentialLookup, SessionMount } from "./index";

/**
 * mountSession — the sealed-browser-session half of the custody broker.
 *
 * The flow, and why each step exists:
 *   1. the credential must be `browser_session` (an api_key never mounts);
 *   2. the SEALED profile location comes from the custody profile store —
 *      custody owns credential → material mapping, exactly as it does for
 *      secrets via CustodyBackend;
 *   3. the pod is reached through an injected BrowserHostPort, so custody
 *      never imports apps/browserhost internals and tests fake one line;
 *   4. the mount is evented for the audit trail (and sentinel's security
 *      watcher) carrying ids ONLY — no profile path, no profile bytes.
 *
 * The returned SessionMount carries a BROKERED cdp url minted by the pod, not
 * the pod's raw DevTools endpoint.
 */

/** The narrow pod surface custody programs against (@lithis/browserhost implements it). */
export interface BrowserHostPort {
  mountSession(input: {
    credentialRef: Ulid;
    sealedProfileDir: string;
  }): Promise<{ sessionId: Ulid; podId: string }>;
  attach(sessionId: Ulid): Promise<{ wsUrl: string }>;
  release(sessionId: Ulid): Promise<void>;
}

export interface MountSessionDeps {
  db: Db;
  spine: EventSpine;
  credentials: CredentialLookup;
  profiles: BrowserProfileStore;
  browserHost: BrowserHostPort;
}

export class NotABrowserSessionError extends Error {
  constructor(
    readonly credentialId: string,
    readonly kind: Credential["kind"],
  ) {
    super(
      `credential ${credentialId} is a '${kind}', not a 'browser_session' — only sealed browser ` +
        `profiles mount into browserhost pods (ADR-003)`,
    );
    this.name = "NotABrowserSessionError";
  }
}

export function createMountSession(deps: MountSessionDeps) {
  return async function mountSession(
    ref: Ulid,
    p: PrincipalContext,
  ): Promise<SessionMount> {
    const credential = await deps.credentials.get(ref);
    if (credential === null || credential.tenantId !== p.tenantId) {
      // Same answer for missing and foreign-tenant refs — no cross-tenant probing.
      throw new Error(`credential ${ref} not found`);
    }
    if (credential.kind !== "browser_session") {
      throw new NotABrowserSessionError(ref, credential.kind);
    }

    const sealedProfileDir = await deps.profiles.resolve(credential.custodyBackendRef);
    const mounted = await deps.browserHost.mountSession({
      credentialRef: ref,
      sealedProfileDir,
    });
    let cdpUrl: string;
    try {
      cdpUrl = (await deps.browserHost.attach(mounted.sessionId)).wsUrl;
    } catch (err) {
      // Never leave a pod holding an unsealed profile because attach failed.
      await deps.browserHost.release(mounted.sessionId);
      throw err;
    }

    const mountedAt = nowIso();
    await deps.db.withTx((tx) =>
      deps.spine.append(tx, {
        tenantId: p.tenantId,
        topic: "browser.session.mounted",
        subjectRefs: [{ kind: "credential", id: ref }],
        actor: { kind: "principal", id: p.principalId },
        // Ids only: no profile directory, no endpoint, no cookie material.
        payload: { credentialId: ref, sessionId: mounted.sessionId, podId: mounted.podId },
      }),
    );

    return {
      credentialId: ref,
      sessionId: mounted.sessionId,
      host: { podId: mounted.podId },
      cdpUrl,
      mountedAt,
    };
  };
}

/** Release a mounted session: re-seal the profile and event the teardown. */
export function createReleaseSession(deps: MountSessionDeps) {
  return async function releaseSession(
    sessionId: Ulid,
    credentialRef: Ulid,
    p: PrincipalContext,
  ): Promise<void> {
    await deps.browserHost.release(sessionId);
    await deps.db.withTx((tx) =>
      deps.spine.append(tx, {
        tenantId: p.tenantId,
        topic: "browser.session.released",
        subjectRefs: [{ kind: "credential", id: credentialRef }],
        actor: { kind: "principal", id: p.principalId },
        payload: { credentialId: credentialRef, sessionId },
      }),
    );
  };
}
