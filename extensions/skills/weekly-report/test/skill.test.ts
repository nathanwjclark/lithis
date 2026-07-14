import { describe, expect, test } from "bun:test";
import { skillManifestSchema } from "@lithis/core";
import { NotImplementedError } from "@lithis/stubkit";
import { run, weeklyReportManifest } from "../src/index";

describe("weekly-report manifest", () => {
  test("validates against skillManifestSchema", () => {
    expect(() => skillManifestSchema.parse(weeklyReportManifest)).not.toThrow();
  });

  test("requires read + delivery capabilities only", () => {
    expect(weeklyReportManifest.capabilitiesRequired).toContain("context.search");
    expect(weeklyReportManifest.capabilitiesRequired).toContain("delivery.send");
    // A report skill must never carry outreach capabilities.
    expect(weeklyReportManifest.capabilitiesRequired).not.toContain("browser.linkedin.connect");
  });

  test("is schedule-triggered weekly", () => {
    expect(weeklyReportManifest.triggers?.schedule).toBe("0 8 * * 1");
  });
});

describe("weekly-report run (stub)", () => {
  test("throws NotImplementedError", () => {
    expect(() => run({})).toThrow(NotImplementedError);
  });
});
