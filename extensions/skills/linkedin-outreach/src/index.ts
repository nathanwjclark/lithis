import { stub } from "@lithis/stubkit";

export { linkedinOutreachManifest } from "./manifest";

/** Skill entrypoint — the executor calls this with validated input. */
export type SkillRun = (input: Record<string, unknown>) => Promise<unknown>;

export const run: SkillRun = stub<SkillRun>(
  "skill.linkedin-outreach.run",
  "LITHIS-STUB: path-ranked outreach (prospect ranking, batch drafting, ActionIntent proposal, approved-item execution) not implemented",
);
