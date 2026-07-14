import { z } from "zod";
import { defineEventType } from "../events";

export const T_SKILL_PROPOSED = defineEventType({
  topic: "skill.version.proposed",
  description: "A skill version was proposed (self-modification enters the guardrail pipeline).",
  payload: z.object({ semver: z.string(), capabilityAdded: z.array(z.string()) }),
});
export const T_SKILL_ACTIVATED = defineEventType({
  topic: "skill.version.activated",
  description: "A skill version activated after PR merge + approval; checksum-bound.",
  payload: z.object({ semver: z.string(), checksum: z.string() }),
});
