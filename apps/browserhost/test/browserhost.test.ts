import { describe, expect, test } from "bun:test";
import { newUlid } from "@lithis/core";
import { NotImplementedError, isStub } from "@lithis/stubkit";
import {
  createBrowserHostService,
  defaultHumanizationPolicy,
  humanizationPolicySchema,
} from "../src/index";

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
      humanizationPolicySchema.safeParse({ ...defaultHumanizationPolicy, captcha: "auto_solve" }).success,
    ).toBe(false);
  });

  test("rejects inverted dwell ranges", () => {
    expect(
      humanizationPolicySchema.safeParse({ ...defaultHumanizationPolicy, dwellMsRange: [5000, 100] }).success,
    ).toBe(false);
  });
});

describe("BrowserHostService (stub)", () => {
  const host = createBrowserHostService();

  test("is a registered stub service", () => {
    expect(isStub(host)).toBe(true);
  });

  test("mountSession throws NotImplementedError", () => {
    expect(() => host.mountSession(newUlid())).toThrow(NotImplementedError);
  });

  test("attach throws NotImplementedError", () => {
    expect(() => host.attach(newUlid())).toThrow(NotImplementedError);
  });

  test("release throws NotImplementedError", () => {
    expect(() => host.release(newUlid())).toThrow(NotImplementedError);
  });

  test("policy throws NotImplementedError", () => {
    expect(() => host.policy()).toThrow(NotImplementedError);
  });
});
