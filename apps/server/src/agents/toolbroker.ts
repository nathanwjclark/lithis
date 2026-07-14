import type { PrincipalContext, SkillManifest } from "@lithis/core";
import type { ToolBroker, ToolDef, ToolSet } from "./index";

/**
 * The ToolBroker — THE scope choke point. The base surface every resident
 * agent gets is deliberately tiny: record a result, report a blocker, journal
 * a note. A SkillManifest widens the surface with ONE additional tool (the
 * skill's own inputSchema); executing that tool is P10-skills territory — the
 * executor fails such calls through the loud executeSkillTool stub in
 * executor.ts.
 *
 * Grant intersection is deferred with the policy layer (ADR-006); the
 * network_only audience pre-filter has no data model yet (capabilities are
 * bare dot-strings) — both arrive with the policy layer, not here.
 */

export const RECORD_RESULT_TOOL = "record_result";
export const REPORT_BLOCKER_TOOL = "report_blocker";
export const ADD_WORK_NOTE_TOOL = "add_work_note";

const BASE_TOOLS: ToolDef[] = [
  {
    name: RECORD_RESULT_TOOL,
    description:
      "Finish the current work item with a result. Call exactly once, when the work is done. " +
      "The summary is what a human reviewer reads first.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "2-4 sentence summary of what was done/found." },
        resultJson: {
          type: "object",
          description: "Structured result matching the brief's result schema, when one was given.",
        },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: REPORT_BLOCKER_TOOL,
    description:
      "Stop working on the current item because something outside your control blocks it. " +
      "Describe exactly what is missing and who/what could unblock it.",
    inputSchema: {
      type: "object",
      properties: {
        blocker: { type: "string", description: "What blocks the work and what would unblock it." },
      },
      required: ["blocker"],
      additionalProperties: false,
    },
  },
  {
    name: ADD_WORK_NOTE_TOOL,
    description:
      "Append a note to the current work item's journal — progress, findings, decisions. " +
      "Notes are durable and visible to humans; use them for anything worth remembering.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The note text." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

/** Anthropic tool names must match ^[a-zA-Z0-9_-]{1,64}$ — flatten capability dots. */
export function skillToolName(description: string): string {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return `skill_${slug.length > 0 ? slug : "tool"}`;
}

export function createCharterToolBroker(): ToolBroker {
  return {
    toolsFor(_p: PrincipalContext, manifest?: SkillManifest): ToolSet {
      const tools = [...BASE_TOOLS];
      if (manifest !== undefined) {
        tools.push({
          name: skillToolName(manifest.description),
          description: manifest.description,
          inputSchema: manifest.inputSchema,
        });
      }
      return { tools };
    },
  };
}
