import { describe, expect, test } from "bun:test";
import { weeklyReportManifest } from "@lithis/skill-weekly-report";
import { skillToolName } from "../src/agents";
import { canonicalJson, createSkillRuntime, manifestChecksum } from "../src/skills";
import type { SkillManifest } from "@lithis/core";

/**
 * P10 units: the in-process registration seam and the manifest-checksum
 * binding (canonical JSON — key order can never change a checksum; any
 * semantic manifest change always does).
 */

const GIT_REF = { repo: "nathanwjclark/lithis", ref: "main", path: "extensions/skills/weekly-report" };

function manifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    description: "Test the registry",
    inputSchema: { type: "object" },
    capabilitiesRequired: ["context.search"],
    selfModBounds: { modifiablePaths: [], forbidden: [] },
    ...overrides,
  };
}

describe("skill runtime (registration seam)", () => {
  test("register → resolve by slug and by broker tool name", () => {
    const runtime = createSkillRuntime();
    const registration = runtime.register({
      slug: "weekly-report",
      kind: "report",
      manifest: weeklyReportManifest,
      run: async () => ({}),
      sourceRef: GIT_REF,
    });
    expect(runtime.resolve("weekly-report")).toBe(registration);
    expect(runtime.resolveTool(skillToolName(weeklyReportManifest.description))).toBe(registration);
    expect(runtime.resolve("nope")).toBeUndefined();
    expect(runtime.resolveTool("skill_nope")).toBeUndefined();
    expect(runtime.list()).toHaveLength(1);
  });

  test("duplicate slugs and colliding tool names are rejected loudly", () => {
    const runtime = createSkillRuntime();
    const reg = {
      slug: "a-skill",
      kind: "tool" as const,
      manifest: manifest(),
      run: async () => ({}),
      sourceRef: GIT_REF,
    };
    runtime.register(reg);
    expect(() => runtime.register(reg)).toThrow(/already registered/);
    expect(() => runtime.register({ ...reg, slug: "b-skill" })).toThrow(/collides/);
  });
});

describe("manifest checksum (canonical JSON)", () => {
  test("canonicalJson sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 }, skip: undefined })).toBe(
      '{"a":{"c":3,"d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });

  test("key order never changes the checksum; a semantic change always does", () => {
    const a = manifest();
    const b = {
      selfModBounds: { forbidden: [], modifiablePaths: [] },
      capabilitiesRequired: ["context.search"],
      inputSchema: { type: "object" },
      description: "Test the registry",
    } as SkillManifest;
    expect(manifestChecksum(a)).toBe(manifestChecksum(b));
    expect(manifestChecksum(a)).not.toBe(
      manifestChecksum(manifest({ capabilitiesRequired: ["context.search", "gmail.send"] })),
    );
    expect(manifestChecksum(a)).not.toBe(manifestChecksum(manifest({ description: "Changed" })));
  });

  test("checksum is stable for the real seed manifests (64-char sha256 hex)", () => {
    const sum = manifestChecksum(weeklyReportManifest);
    expect(sum).toMatch(/^[0-9a-f]{64}$/);
    expect(manifestChecksum(weeklyReportManifest)).toBe(sum);
  });
});
