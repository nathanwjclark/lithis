import type { SkillManifest } from "@lithis/core";

/**
 * linkedin-outreach — turns ranked degree-2 prospects into an ActionIntent
 * batch (one HumanRequest, per-item verdicts) and, once approved, executes
 * connect/message actions through the linkedin connector under browserhost
 * humanization. Never contacts anyone without an approved batch. REAL
 * manifest data, validated in tests.
 */
export const linkedinOutreachManifest: SkillManifest = {
  description:
    "Given a prospect segment, rank targets by connection paths (RelationshipGraph.paths over links x relationship scores, prospecting audience), draft per-target connect notes / messages, propose them as one ActionIntent batch for approval, and execute only the approved items via the linkedin connector.",
  inputSchema: {
    type: "object",
    properties: {
      segmentQuery: {
        type: "string",
        description: "Context search query selecting the degree-2 prospect segment (e.g. a saved salesnav sweep).",
      },
      batchSize: {
        type: "integer",
        minimum: 1,
        maximum: 40,
        description: "Max actions to propose in one batch (bounded by the humanization hourly cap).",
      },
      mode: {
        type: "string",
        enum: ["connect", "message", "mixed"],
        description: "Which outreach action(s) to draft.",
      },
    },
    required: ["segmentQuery"],
    additionalProperties: false,
  },
  // Prospecting-audience search + the browser outreach capabilities (ToolBroker choke points).
  capabilitiesRequired: ["context.search", "browser.linkedin.connect", "browser.linkedin.message"],
  selfModBounds: {
    modifiablePaths: ["src/outreach-prompt.md", "src/note-templates.md"],
    forbidden: ["src/manifest.ts", "src/index.ts"],
  },
};
