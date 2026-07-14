import { describe, expect, test } from "bun:test";
import { defineSkillManifest } from "../src/skills";

const valid = {
  description: "Weekly pipeline report over context + relationship scores",
  inputSchema: { type: "object", properties: { week: { type: "string" } } },
  capabilitiesRequired: ["context.search", "delivery.slack.post"],
  triggers: { schedule: "0 8 * * 1" },
  selfModBounds: {
    modifiablePaths: ["prompt.md", "sections/"],
    forbidden: ["manifest.json"],
  },
};

describe("defineSkillManifest", () => {
  test("round-trips a valid manifest against the core schema", () => {
    const manifest = defineSkillManifest(valid);
    expect(manifest.description).toBe(valid.description);
    expect(manifest.capabilitiesRequired).toEqual(valid.capabilitiesRequired);
    expect(manifest.triggers?.schedule).toBe("0 8 * * 1");
    expect(manifest.selfModBounds.forbidden).toEqual(["manifest.json"]);
  });

  test("applies core defaults (capabilitiesRequired, selfModBounds arrays)", () => {
    const manifest = defineSkillManifest({
      description: "Minimal skill",
      inputSchema: {},
      selfModBounds: {},
    });
    expect(manifest.capabilitiesRequired).toEqual([]);
    expect(manifest.selfModBounds.modifiablePaths).toEqual([]);
    expect(manifest.selfModBounds.forbidden).toEqual([]);
  });

  test("rejects a manifest with a non-namespaced capability", () => {
    expect(() =>
      defineSkillManifest({ ...valid, capabilitiesRequired: ["searcheverything"] }),
    ).toThrow();
  });

  test("rejects a manifest missing selfModBounds", () => {
    const { selfModBounds: _bounds, ...withoutBounds } = valid;
    // @ts-expect-error — selfModBounds is required by the core schema
    expect(() => defineSkillManifest(withoutBounds)).toThrow();
  });

  test("rejects a malformed trigger cron", () => {
    expect(() =>
      defineSkillManifest({ ...valid, triggers: { schedule: "every monday" } }),
    ).toThrow();
  });
});
