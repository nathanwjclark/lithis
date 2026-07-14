import { describe, expect, test } from "bun:test";
import { expectStub } from "@lithis/evals";
import { browserActionSchema, openBrowserSession, PaceGuard } from "../src/browser";

/** Deterministic rand: yields the given values in order, then repeats the last. */
function seededRand(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

describe("browserActionSchema", () => {
  test("parses each action contract", () => {
    expect(
      browserActionSchema.parse({ kind: "navigate", url: "https://example.com/login" }).kind,
    ).toBe("navigate");
    expect(
      browserActionSchema.parse({ kind: "extract", selector: ".profile-name" }).kind,
    ).toBe("extract");
    expect(browserActionSchema.parse({ kind: "click", selector: "#connect" }).kind).toBe("click");
    expect(
      browserActionSchema.parse({ kind: "captcha_pause", reason: "checkpoint page detected" })
        .kind,
    ).toBe("captcha_pause");
  });

  test("rejects a navigate with a non-URL and an unknown kind", () => {
    expect(() => browserActionSchema.parse({ kind: "navigate", url: "not a url" })).toThrow();
    expect(() => browserActionSchema.parse({ kind: "solve_captcha", token: "x" })).toThrow();
  });
});

describe("PaceGuard", () => {
  test("first action may go immediately", () => {
    const guard = new PaceGuard({ minDelayMs: 1000, jitterMs: 500, maxPerHour: 10 });
    expect(guard.nextDelay()).toBe(0);
  });

  test("enforces minDelay + jitter spacing after an action (deterministic)", () => {
    let now = 0;
    const guard = new PaceGuard({
      minDelayMs: 500,
      jitterMs: 1000,
      maxPerHour: 100,
      rand: seededRand([0.9, 0.1]),
      now: () => now,
    });
    guard.recordAction(); // at t=0
    expect(guard.nextDelay()).toBe(500 + 900); // jitter draw 0.9 → 900
    expect(guard.nextDelay()).toBe(500 + 100); // jitter draw 0.1 → 100
    now = 550;
    expect(guard.nextDelay()).toBe(500 + 100 - 550); // partial wait elapsed
  });

  test("two guards with the same seed and clock behave identically", () => {
    const build = () => {
      let now = 0;
      const guard = new PaceGuard({
        minDelayMs: 250,
        jitterMs: 400,
        maxPerHour: 5,
        rand: seededRand([0.5, 0.25, 0.75]),
        now: () => now,
      });
      const observed: number[] = [];
      guard.recordAction();
      observed.push(guard.nextDelay());
      now = 300;
      guard.recordAction();
      observed.push(guard.nextDelay(), guard.nextDelay());
      return observed;
    };
    expect(build()).toEqual(build());
  });

  test("hourly cap gates on the oldest action in the window", () => {
    let now = 0;
    const guard = new PaceGuard({
      minDelayMs: 1000,
      jitterMs: 0,
      maxPerHour: 2,
      now: () => now,
    });
    guard.recordAction(); // t=0
    now = 1000;
    guard.recordAction(); // t=1000
    now = 2000;
    // Spacing is satisfied (last + 1000 = 2000), but 2 actions sit in the window:
    // the t=0 action must age out at t=3_600_000.
    expect(guard.nextDelay()).toBe(3_600_000 - 2000);
  });

  test("actions age out of the sliding window", () => {
    let now = 0;
    const guard = new PaceGuard({ minDelayMs: 0, jitterMs: 0, maxPerHour: 2, now: () => now });
    guard.recordAction(); // t=0
    now = 1000;
    guard.recordAction(); // t=1000
    expect(guard.actionsInWindow).toBe(2);
    now = 3_600_001; // t=0 action is now outside the window
    expect(guard.actionsInWindow).toBe(1);
    expect(guard.nextDelay()).toBe(0);
  });

  test("rejects nonsense construction", () => {
    expect(() => new PaceGuard({ minDelayMs: -1, jitterMs: 0, maxPerHour: 1 })).toThrow(
      RangeError,
    );
    expect(() => new PaceGuard({ minDelayMs: 0, jitterMs: -5, maxPerHour: 1 })).toThrow(
      RangeError,
    );
    expect(() => new PaceGuard({ minDelayMs: 0, jitterMs: 0, maxPerHour: 0 })).toThrow(RangeError);
  });
});

describe("openBrowserSession (stub)", () => {
  test("throws NotImplementedError with the registered stub id", () => {
    const error = expectStub(() => openBrowserSession("mount-ref"));
    expect(error.stubId).toBe("sdk.browser.session");
  });
});
