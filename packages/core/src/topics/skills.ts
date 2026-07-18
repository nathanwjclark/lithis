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
export const T_SKILL_RUN_STARTED = defineEventType({
  topic: "skill.run.started",
  description: "A skill execution began (schedule tick, agent tool call, or manual invoke).",
  payload: z.object({ slug: z.string().min(1), trigger: z.enum(["schedule", "tool", "manual"]) }),
});
export const T_SKILL_RUN_FINISHED = defineEventType({
  topic: "skill.run.finished",
  description: "A skill execution finished — succeeded or failed, never silent.",
  payload: z.object({
    slug: z.string().min(1),
    trigger: z.enum(["schedule", "tool", "manual"]),
    status: z.enum(["succeeded", "failed"]),
  }),
});
