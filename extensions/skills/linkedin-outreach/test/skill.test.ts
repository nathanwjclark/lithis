import { describe, expect, test } from "bun:test";
import { skillManifestSchema } from "@lithis/core";
import { NotImplementedError } from "@lithis/stubkit";
import { linkedinOutreachManifest, run } from "../src/index";

describe("linkedin-outreach manifest", () => {
  test("validates against skillManifestSchema", () => {
    expect(() => skillManifestSchema.parse(linkedinOutreachManifest)).not.toThrow();
  });

  test("requires browser.linkedin.connect + context.search (the accurate capability set)", () => {
    expect(linkedinOutreachManifest.capabilitiesRequired).toContain("browser.linkedin.connect");
    expect(linkedinOutreachManifest.capabilitiesRequired).toContain("browser.linkedin.message");
    expect(linkedinOutreachManifest.capabilitiesRequired).toContain("context.search");
  });

  test("carries no email/slack send capabilities — outreach is browser-only", () => {
    expect(linkedinOutreachManifest.capabilitiesRequired).not.toContain("gmail.send");
    expect(linkedinOutreachManifest.capabilitiesRequired).not.toContain("slack.chat.write");
  });

  test("is not self-triggered: no schedule, invoked by the BD resident agent", () => {
    expect(linkedinOutreachManifest.triggers).toBeUndefined();
  });
});

describe("linkedin-outreach run (stub)", () => {
  test("throws NotImplementedError", () => {
    expect(() => run({ segmentQuery: "nj insurance brokerage partners" })).toThrow(NotImplementedError);
  });
});
