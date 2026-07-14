import type { SkillManifest } from "@lithis/core";

/**
 * weekly-report — a report-kind skill (reporting is dissolved into
 * skills + recurring WorkItems + delivery). REAL manifest data, validated
 * against skillManifestSchema in tests.
 */
export const weeklyReportManifest: SkillManifest = {
  description:
    "Compile the weekly digest: work completed and blocked, approvals pending past SLA, relationship movement (new/warming/cooling contacts), and connector health — searched from the context store and work graph, rendered as markdown, and handed to delivery.",
  inputSchema: {
    type: "object",
    properties: {
      weekOf: {
        type: "string",
        format: "date",
        description: "Monday of the week to report on; defaults to the current week.",
      },
      sections: {
        type: "array",
        items: { type: "string", enum: ["work", "approvals", "relationships", "connections"] },
        description: "Which sections to include; defaults to all.",
      },
    },
    additionalProperties: false,
  },
  // Read-only over context/work plus the delivery hand-off; network audience only.
  capabilitiesRequired: ["context.search", "work.read", "delivery.send"],
  triggers: {
    schedule: "0 8 * * 1",
  },
  selfModBounds: {
    modifiablePaths: ["src/prompt.md", "src/sections.md"],
    forbidden: ["src/manifest.ts", "src/index.ts"],
  },
};
