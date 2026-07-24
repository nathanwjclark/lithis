import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUlid, nowIso } from "@lithis/core";
import type { Ulid } from "@lithis/core";
import { createCdpBroker } from "./broker";
import type { CdpBroker, CdpBrokerDenial } from "./broker";
import { defaultHumanizationPolicy, humanizationPolicySchema } from "./policy";
import type { HumanizationPolicy } from "./policy";
import type { ChromeLaunchHandle, ChromeLauncher } from "./launcher";
import type {
  BrowserHostService,
  BrowserSessionHandle,
  CdpAttachment,
  MountRequest,
} from "./index";

/**
 * The pod runtime. One mounted session = one ephemeral pod directory holding
 * an UNSEALED copy of a custody browser profile + one headed Chrome + (once
 * attached) one CDP broker.
 *
 * The sealed↔pod copy is the whole custody contract in two lines: unseal on
 * mount, re-seal on release, delete the pod dir either way. Nothing else in
 * the system ever touches profile bytes, and no profile path or byte is
 * logged, evented, or returned to a caller.
 */

export interface BrowserHostEvent {
  kind: "mounted" | "attached" | "released" | "cdp_denied";
  sessionId: Ulid;
  credentialRef?: Ulid;
  at: string;
  /** Present for cdp_denied only — the refused method + why. */
  denial?: Omit<CdpBrokerDenial, "sessionId" | "at">;
}

export interface BrowserHostDeps {
  /** The process seam. Production: createSystemChromeLauncher(). */
  launcher: ChromeLauncher;
  /** Identifier this pod reports to custody (default: a per-process ULID). */
  podId?: string;
  /** Parent directory for ephemeral pod profile dirs (default: os tmpdir). */
  podRoot?: string;
  /** The humanization policy every attached session is paced by. */
  policy?: HumanizationPolicy;
  /** Observability hook — the server turns these into spine events. */
  onEvent?: (event: BrowserHostEvent) => void;
  /** Injectable for tests. */
  now?: () => string;
}

interface MountedSession {
  sessionId: Ulid;
  credentialRef: Ulid;
  sealedProfileDir: string;
  podDir: string;
  chrome: ChromeLaunchHandle;
  broker?: CdpBroker;
}

export class UnknownSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`browserhost has no mounted session ${sessionId}`);
    this.name = "UnknownSessionError";
  }
}

export function createRealBrowserHostService(deps: BrowserHostDeps): BrowserHostService {
  const podId = deps.podId ?? `pod-${newUlid()}`;
  const podRoot = deps.podRoot ?? join(tmpdir(), "lithis-browserhost");
  const policy = humanizationPolicySchema.parse(deps.policy ?? defaultHumanizationPolicy);
  const now = deps.now ?? nowIso;
  const sessions = new Map<Ulid, MountedSession>();

  function emit(event: BrowserHostEvent): void {
    deps.onEvent?.(event);
  }

  function requireSession(sessionId: Ulid): MountedSession {
    const session = sessions.get(sessionId);
    if (session === undefined) throw new UnknownSessionError(sessionId);
    return session;
  }

  return {
    podId,

    async mountSession(request: MountRequest): Promise<BrowserSessionHandle> {
      await mkdir(podRoot, { recursive: true });
      const podDir = await mkdtemp(join(podRoot, "session-"));
      let chrome: ChromeLaunchHandle;
      try {
        // Unseal: the sealed profile is copied INTO the pod, never mounted in
        // place — a crashed pod can never corrupt the custody copy.
        await cp(request.sealedProfileDir, podDir, { recursive: true });
        chrome = await deps.launcher.launch({ userDataDir: podDir });
      } catch (err) {
        await rm(podDir, { recursive: true, force: true });
        throw err;
      }
      const sessionId = newUlid();
      sessions.set(sessionId, {
        sessionId,
        credentialRef: request.credentialRef,
        sealedProfileDir: request.sealedProfileDir,
        podDir,
        chrome,
      });
      emit({ kind: "mounted", sessionId, credentialRef: request.credentialRef, at: now() });
      return { sessionId, credentialRef: request.credentialRef, podId };
    },

    async attach(sessionId: Ulid): Promise<CdpAttachment> {
      const session = requireSession(sessionId);
      // One live broker per session: re-attaching mints a fresh single-use
      // token and retires the previous channel.
      await session.broker?.close();
      const broker = createCdpBroker({
        sessionId,
        upstreamWsUrl: session.chrome.wsEndpoint,
        onDenied: (denial) =>
          emit({
            kind: "cdp_denied",
            sessionId,
            credentialRef: session.credentialRef,
            at: denial.at,
            denial: { method: denial.method, rule: denial.rule, reason: denial.reason },
          }),
      });
      session.broker = broker;
      emit({ kind: "attached", sessionId, credentialRef: session.credentialRef, at: now() });
      return { sessionId, wsUrl: broker.wsUrl };
    },

    async release(sessionId: Ulid): Promise<void> {
      const session = requireSession(sessionId);
      sessions.delete(sessionId);
      await session.broker?.close();
      await session.chrome.close();
      // Re-seal: stage the pod's (now updated) profile beside the custody copy
      // and swap it in, so a failed copy can never destroy the sealed profile.
      const staged = `${session.sealedProfileDir}.resealing`;
      try {
        await rm(staged, { recursive: true, force: true });
        await cp(session.podDir, staged, { recursive: true });
        await rm(session.sealedProfileDir, { recursive: true, force: true });
        await rename(staged, session.sealedProfileDir);
      } finally {
        await rm(staged, { recursive: true, force: true });
        await rm(session.podDir, { recursive: true, force: true });
      }
      emit({ kind: "released", sessionId, credentialRef: session.credentialRef, at: now() });
    },

    policy(): HumanizationPolicy {
      return policy;
    },
  };
}
