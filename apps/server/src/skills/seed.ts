import { nowIso } from "@lithis/core";
import type { Ulid } from "@lithis/core";
import type { HumanGate } from "../humangate";
import type { SkillRuntime } from "./runtime";
import type { SkillRegistry } from "./index";

/**
 * Dev-seed skill activation (user decision 2): the two seed skills go
 * through the REAL lifecycle — propose → approve the skill_change
 * HumanRequest → checksum-bound activate — so cron ticks fire locally out of
 * the box. GUARD: this only ever runs against the dev-seed tenant (main.ts
 * calls it only when the iam dev seed exists); production tenants activate
 * skills through the API only.
 */

export const DEV_SEED_SKILL_SLUGS = ["weekly-report", "follow-up-cadence"] as const;

export interface DevSkillsSeedDeps {
  registry: SkillRegistry;
  runtime: SkillRuntime;
  humanGate: HumanGate;
  tenantId: Ulid;
  principalId: Ulid;
}

export async function ensureDevSkillsSeed(deps: DevSkillsSeedDeps): Promise<{ activated: string[] }> {
  const activated: string[] = [];
  const existing = await deps.registry.list(deps.tenantId);
  for (const slug of DEV_SEED_SKILL_SLUGS) {
    const registration = deps.runtime.resolve(slug);
    if (registration === undefined) continue; // not registered in this build — nothing to seed
    if (existing.find((s) => s.slug === slug)?.currentVersionId !== undefined) continue; // already live

    const { versionId, approvalRequestId } = await deps.registry.propose({
      tenantId: deps.tenantId,
      slug,
      kind: registration.kind,
      semver: "0.1.0",
      sourceRef: registration.sourceRef,
      manifest: registration.manifest,
      authoredBy: { kind: "principal", id: deps.principalId },
    });
    await deps.humanGate.resolve(
      approvalRequestId,
      {
        by: { kind: "principal", id: deps.principalId },
        at: nowIso(),
        verdict: "approved",
        comment: "dev seed auto-approval (dev tenant only — prod activates via the API)",
      },
      { tenantId: deps.tenantId, principalId: deps.principalId, kind: "human" },
    );
    await deps.registry.activate(versionId, deps.tenantId);
    activated.push(slug);
  }
  return { activated };
}
