import type { SkillManifest } from "@lithis/core";

/**
 * follow-up-cadence — works due WorkItem.followUp entries: external parties
 * (regulators, carriers, counterparties) are NOT HumanRequests; they get
 * cadence-driven nudges via approved connector sends, with escalation after
 * escalateAfterDays. REAL manifest data, validated in tests.
 */
export const followUpCadenceManifest: SkillManifest = {
  description:
    "Sweep work items whose followUp.nextAt is due: draft the nudge from the thread history, send it via the counterpart's channel (email/Slack), record lastContactAt, advance nextAt per cadence, and escalate to the configured principal when escalateAfterDays is exceeded.",
  inputSchema: {
    type: "object",
    properties: {
      workItemId: {
        type: "string",
        description: "Specific work item to follow up; when omitted the skill sweeps all due follow-ups.",
      },
      dryRun: {
        type: "boolean",
        description: "Draft nudges without sending (returns proposed ActionIntents).",
      },
    },
    additionalProperties: false,
  },
  // Updating the cadence bookkeeping + the channel send capabilities it nudges through.
  capabilitiesRequired: ["work.followup.update", "gmail.send", "m365.mail.send", "slack.chat.write"],
  triggers: {
    // The clock is the real wake source (followUp.nextAt); this daily sweep is the safety net.
    schedule: "0 9 * * 1-5",
  },
  selfModBounds: {
    modifiablePaths: ["src/nudge-prompt.md"],
    forbidden: ["src/manifest.ts", "src/index.ts"],
  },
};
