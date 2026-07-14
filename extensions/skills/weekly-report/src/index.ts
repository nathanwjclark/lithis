import { stub } from "@lithis/stubkit";

export { weeklyReportManifest } from "./manifest";

/** Skill entrypoint — the executor calls this with validated input. */
export type SkillRun = (input: Record<string, unknown>) => Promise<unknown>;

export const run: SkillRun = stub<SkillRun>(
  "skill.weekly-report.run",
  "LITHIS-STUB: weekly digest assembly (context/work queries + markdown render + delivery hand-off) not implemented",
);
