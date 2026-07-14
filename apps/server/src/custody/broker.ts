import type { Credential, PrincipalContext, Ref, Ulid } from "@lithis/core";
import type { BrokeredAuth, CustodyDeps, CustodyRuntime, RedeemedSecret } from "./index";

/**
 * The real credential broker. getBrokered/issueFor: look up the credential
 * record (via the connections-owned directory seam), pull the material from
 * the CustodyBackend, and mint a short-lived opaque brokerToken whose
 * redemption map lives in-process — the secret never rides the BrokeredAuth,
 * never lands in an event, and never crosses the API. Every issuance emits
 * custody.credential.brokered on the spine (the audit trail the concepts doc
 * demands). mountSession (sealed browser profiles) stays a loud stub until
 * the browserhost lands (P12).
 */

export const DEFAULT_BROKER_TTL_MS = 15 * 60 * 1000;

export interface TokenVault {
  mint(entry: RedeemedSecret): { brokerToken: string; expiresAt: string };
  /** Throws on unknown or expired tokens; expired entries are pruned. */
  redeem(brokerToken: string): RedeemedSecret;
}

export function createTokenVault(opts?: { ttlMs?: number; nowMs?: () => number }): TokenVault {
  const ttlMs = opts?.ttlMs ?? DEFAULT_BROKER_TTL_MS;
  const nowMs = opts?.nowMs ?? Date.now;
  const entries = new Map<string, { secret: RedeemedSecret; expiresAtMs: number }>();

  function prune(): void {
    const now = nowMs();
    for (const [token, entry] of entries) {
      if (entry.expiresAtMs <= now) entries.delete(token);
    }
  }

  return {
    mint(entry: RedeemedSecret) {
      prune();
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const brokerToken = `bkr_${Buffer.from(bytes).toString("base64url")}`;
      const expiresAtMs = nowMs() + ttlMs;
      entries.set(brokerToken, { secret: entry, expiresAtMs });
      return { brokerToken, expiresAt: new Date(expiresAtMs).toISOString() };
    },
    redeem(brokerToken: string): RedeemedSecret {
      prune();
      const entry = entries.get(brokerToken);
      if (entry === undefined) {
        throw new Error("unknown or expired broker token — request a fresh BrokeredAuth from custody");
      }
      return entry.secret;
    },
  };
}

export function createCustodyBroker(
  deps: CustodyDeps,
  mountSession: CustodyRuntime["mountSession"],
): CustodyRuntime {
  const vault = createTokenVault({
    ...(deps.ttlMs !== undefined ? { ttlMs: deps.ttlMs } : {}),
    ...(deps.nowMs !== undefined ? { nowMs: deps.nowMs } : {}),
  });

  async function issueFor(credentialId: Ulid, tenantId: Ulid, actor: Ref): Promise<BrokeredAuth> {
    const credential: Credential | null = await deps.credentials.get(credentialId);
    if (credential === null || credential.tenantId !== tenantId) {
      // Same answer for missing and foreign-tenant refs — no cross-tenant probing.
      throw new Error(`credential ${credentialId} not found`);
    }
    const secret = await deps.backend.getSecret(credential.custodyBackendRef);
    const { brokerToken, expiresAt } = vault.mint({
      credentialId,
      kind: credential.kind,
      secret,
    });
    await deps.db.withTx((tx) =>
      deps.spine.append(tx, {
        tenantId,
        topic: "custody.credential.brokered",
        subjectRefs: [{ kind: "credential", id: credentialId }],
        actor,
        payload: { credentialId, kind: credential.kind, expiresAt },
      }),
    );
    return { credentialId, kind: credential.kind, brokerToken, expiresAt };
  }

  return {
    getBrokered(ref: Ulid, p: PrincipalContext): Promise<BrokeredAuth> {
      return issueFor(ref, p.tenantId, { kind: "principal", id: p.principalId });
    },
    issueFor,
    async redeem(brokerToken: string): Promise<RedeemedSecret> {
      return vault.redeem(brokerToken);
    },
    mountSession,
  };
}
