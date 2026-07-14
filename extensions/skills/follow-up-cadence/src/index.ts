import { stub } from "@lithis/stubkit";

export { followUpCadenceManifest } from "./manifest";

/** Skill entrypoint — the executor calls this with validated input. */
export type SkillRun = (input: Record<string, unknown>) => Promise<unknown>;

export const run: SkillRun = stub<SkillRun>(
  "skill.follow-up-cadence.run",
  "LITHIS-STUB: follow-up sweep (due-cadence query, nudge drafting, channel send, escalation) not implemented",
);
