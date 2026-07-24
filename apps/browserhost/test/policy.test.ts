import { describe, expect, test } from "bun:test";
import { defaultHumanizationPolicy, humanizationPolicySchema } from "../src/index";

describe("HumanizationPolicy (real config)", () => {
  test("default policy parses against the schema", () => {
    const parsed = humanizationPolicySchema.parse(defaultHumanizationPolicy);
    expect(parsed).toEqual(defaultHumanizationPolicy);
  });

  test("default policy is timing-only and pauses on CAPTCHA", () => {
    expect(defaultHumanizationPolicy.captcha).toBe("pause_and_notify");
    expect(defaultHumanizationPolicy.minDelayMs).toBeGreaterThan(0);
    expect(defaultHumanizationPolicy.maxActionsPerHour).toBeGreaterThan(0);
    const [min, max] = defaultHumanizationPolicy.dwellMsRange;
    expect(min).toBeLessThanOrEqual(max);
  });

  test("rejects auto-solve captcha values", () => {
    expect(
      humanizationPolicySchema.safeParse({ ...defaultHumanizationPolicy, captcha: "auto_solve" })
        .success,
    ).toBe(false);
  });

  test("rejects inverted dwell ranges", () => {
    expect(
      humanizationPolicySchema.safeParse({ ...defaultHumanizationPolicy, dwellMsRange: [5000, 100] })
        .success,
    ).toBe(false);
  });
});
