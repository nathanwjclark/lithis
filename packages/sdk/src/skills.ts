import type { z } from "zod";
import type { SkillManifest } from "@lithis/core";
import { skillManifestSchema } from "@lithis/core";

/**
 * Skill authoring kit. A skill's manifest (description, input schema,
 * capabilities required, triggers, self-modification bounds) is validated
 * against the canonical @lithis/core schema at authoring time so a bad
 * manifest fails in the author's editor/tests, not at registry propose time.
 */

export type SkillManifestInput = z.input<typeof skillManifestSchema>;

/** Validate + normalize a skill manifest. Throws ZodError on invalid input. */
export function defineSkillManifest(data: SkillManifestInput): SkillManifest {
  return skillManifestSchema.parse(data);
}
