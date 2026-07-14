import { describe, expect, test } from "bun:test";
import { skillManifestSchema } from "@lithis/core";
import { NotImplementedError } from "@lithis/stubkit";
import { followUpCadenceManifest, run } from "../src/index";

describe("follow-up-cadence manifest", () => {
  test("validates against skillManifestSchema", () => {
    expect(() => skillManifestSchema.parse(followUpCadenceManifest)).not.toThrow();
  });

  test("requires followUp bookkeeping + channel send capabilities", () => {
    expect(followUpCadenceManifest.capabilitiesRequired).toContain("work.followup.update");
    const sends = followUpCadenceManifest.capabilitiesRequired.filter((c) =>
      ["gmail.send", "m365.mail.send", "slack.chat.write"].includes(c),
    );
    expect(sends.length).toBeGreaterThanOrEqual(2);
  });

  test("has a weekday sweep schedule", () => {
    expect(followUpCadenceManifest.triggers?.schedule).toBe("0 9 * * 1-5");
  });
});

describe("follow-up-cadence run (stub)", () => {
  test("throws NotImplementedError", () => {
    expect(() => run({ dryRun: true })).toThrow(NotImplementedError);
  });
});
