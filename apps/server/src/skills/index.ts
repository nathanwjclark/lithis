import type { PrincipalContext, Skill, SkillVersion, Ulid } from "@lithis/core";
import { stubService } from "@lithis/stubkit";
import type { HumanRequestId } from "../humangate";

/**
 * skills — git-authoritative definitions with the guarded self-modification
 * lifecycle: propose → evals → PR → approval → activate. The registry stores
 * checksum-bound git refs, never source; capabilityDiff is the
 * capability-creep check a human reviews in the skill_change HumanRequest.
 */

/** What an author (human or agent) submits; evals + capabilityDiff are computed by propose(). */
export type SkillVersionDraft = Pick<
  SkillVersion,
  "skillId" | "semver" | "sourceRef" | "manifest" | "authoredBy"
> & { tenantId: Ulid };

export interface SkillRegistry {
  /** Runs evals, computes capabilityDiff, then gates via HumanRequest{skill_change}. */
  propose(draft: SkillVersionDraft): Promise<HumanRequestId>;
  /** Only after PR merge + approval; checksum-bound to the approved content. */
  activate(versionId: Ulid): Promise<void>;
  /** The skills this principal may invoke (charter-scoped; grant intersection deferred). */
  forPrincipal(p: PrincipalContext): Promise<Skill[]>;
}

const skillRegistry = stubService<SkillRegistry>(
  "server.skills.registry",
  ["propose", "activate", "forPrincipal"],
  "LITHIS-STUB: skill lifecycle (eval gate, capabilityDiff, checksum-bound activation) not implemented",
);

export function createSkillRegistry(): SkillRegistry {
  return skillRegistry;
}
