import { nowIso } from "@lithis/core";
import type { Origin, Principal, Ulid } from "@lithis/core";
import type { ServerConfig } from "../config";
import type { ContextStore } from "../context";
import type { IdentityService } from "../iam";
import { DEFAULT_AGENT_MODEL } from "../agents";
import { defaultWatcherCharters } from "./index";
import type { WatcherCharterConfig, WatcherHost } from "./index";

/**
 * The real WatcherHost: idempotently mints the default watcher fleet per
 * tenant — one Principal{kind:'agent'} + AgentCharter per shipped config. The
 * charter is synthesized honestly from real primitives:
 *
 * - promptRef → the role prose ingested as a REAL context doc (type
 *   `agent-prompt`, not quarantined — it is first-party configuration, not
 *   untrusted content);
 * - memoryBlobId → a real (near-empty) notebook blob per watcher; reading it
 *   at wake stays behind the existing `server.agents.host.memory` stub;
 * - modelPolicy → config.agentModel (or the executor default) for all three
 *   slots — per-charter model routing is a later refinement (host.ts note);
 * - budgets → conservative watcher defaults, overridable per config;
 * - wake → the config's wake block verbatim.
 *
 * Idempotency is lookup-before-create on (tenant, slug) and on the charter
 * row, so running ensureDefaults on every boot/tenant-created event is safe.
 */

export const DEFAULT_WATCHER_BUDGETS = { usdPerRun: 0.25, usdPerDay: 5 } as const;

export interface WatcherHostDeps {
  identity: IdentityService;
  contextStore: ContextStore;
  config: Pick<ServerConfig, "agentModel">;
}

function displayNameFor(slug: string): string {
  return slug
    .split(/[-_]/)
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function createWatcherHost(deps: WatcherHostDeps): WatcherHost {
  const model = deps.config.agentModel ?? DEFAULT_AGENT_MODEL;

  async function ensureOne(tenantId: Ulid, cfg: WatcherCharterConfig): Promise<void> {
    let principal = await deps.identity.getPrincipalBySlug(tenantId, cfg.slug);
    if (principal === null) {
      principal = await deps.identity.createPrincipal({
        tenantId,
        kind: "agent",
        slug: cfg.slug,
        displayName: displayNameFor(cfg.slug),
        status: "active",
      });
    }
    if ((await deps.identity.getCharter(principal.id)) !== null) return;

    const origin: Origin = {
      by: { kind: "principal", id: principal.id },
      method: "code",
      trust: "internal",
      at: nowIso(),
    };
    const promptBlob = await deps.contextStore.putBlob(
      { tenantId, mediaType: "text/markdown", origin },
      new TextEncoder().encode(cfg.role),
    );
    const promptDoc = await deps.contextStore.ingestDoc({
      tenantId,
      type: "agent-prompt",
      slug: `${cfg.slug}-prompt`,
      title: `${displayNameFor(cfg.slug)} charter prompt`,
      bodyBlobId: promptBlob.id,
      frontmatter: { watcherSlug: cfg.slug },
      origin,
      quarantined: false, // first-party configuration, not untrusted content
    });
    // Per-watcher notebook seed (distinct bytes per slug — putBlob dedupes
    // identical content per tenant, and each watcher needs its OWN notebook).
    const memoryBlob = await deps.contextStore.putBlob(
      { tenantId, mediaType: "text/markdown", origin },
      new TextEncoder().encode(`# ${cfg.slug} memory notebook\n`),
    );
    await deps.identity.createCharter({
      principalId: principal.id,
      tenantId,
      role: cfg.role,
      promptRef: { kind: "doc", id: promptDoc.id },
      memoryBlobId: memoryBlob.id,
      modelPolicy: { plan: model, execute: model, index: model },
      budgets: cfg.budgets ?? { ...DEFAULT_WATCHER_BUDGETS },
      wake: cfg.wake,
    });
  }

  return {
    async ensureDefaults(tenantId: Ulid): Promise<void> {
      for (const cfg of defaultWatcherCharters) {
        await ensureOne(tenantId, cfg);
      }
    },

    async list(tenantId: Ulid): Promise<Principal[]> {
      const principals: Principal[] = [];
      for (const cfg of defaultWatcherCharters) {
        const p = await deps.identity.getPrincipalBySlug(tenantId, cfg.slug);
        if (p !== null) principals.push(p);
      }
      return principals;
    },
  };
}
