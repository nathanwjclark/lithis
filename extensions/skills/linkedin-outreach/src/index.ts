import type { SkillRun } from "@lithis/sdk/skills";
import { stub } from "@lithis/stubkit";

export { linkedinOutreachManifest } from "./manifest";

/** Skill entrypoint — the invoker calls this with validated input + context (P12). */
export const run: SkillRun = stub<SkillRun>(
  "skill.linkedin-outreach.run",
  "LITHIS-STUB: path-ranked outreach (prospect ranking, batch drafting, ActionIntent proposal, approved-item execution) not implemented",
);
