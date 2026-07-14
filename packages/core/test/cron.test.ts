import { describe, expect, test } from "bun:test";
import { cronMatches, cronSchema } from "@lithis/core";

// Local-time dates: (year, monthIndex, day, hour, minute)
const d = (y: number, mo: number, day: number, h: number, mi: number) =>
  new Date(y, mo - 1, day, h, mi);

describe("cronMatches", () => {
  test("* * * * * matches any minute", () => {
    expect(cronMatches("* * * * *", d(2026, 7, 14, 3, 41))).toBe(true);
  });

  test("exact minute + hour", () => {
    expect(cronMatches("30 9 * * *", d(2026, 7, 14, 9, 30))).toBe(true);
    expect(cronMatches("30 9 * * *", d(2026, 7, 14, 9, 31))).toBe(false);
    expect(cronMatches("30 9 * * *", d(2026, 7, 14, 10, 30))).toBe(false);
  });

  test("weekday range: 0 9 * * 1-5 fires weekdays only", () => {
    expect(cronMatches("0 9 * * 1-5", d(2026, 7, 14, 9, 0))).toBe(true); // Tuesday
    expect(cronMatches("0 9 * * 1-5", d(2026, 7, 12, 9, 0))).toBe(false); // Sunday
  });

  test("steps: */15 fires on quarter hours", () => {
    for (const minute of [0, 15, 30, 45]) {
      expect(cronMatches("*/15 * * * *", d(2026, 7, 14, 5, minute))).toBe(true);
    }
    expect(cronMatches("*/15 * * * *", d(2026, 7, 14, 5, 7))).toBe(false);
  });

  test("ranges with steps: 1-30/10", () => {
    expect(cronMatches("1-30/10 * * * *", d(2026, 7, 14, 5, 1))).toBe(true);
    expect(cronMatches("1-30/10 * * * *", d(2026, 7, 14, 5, 11))).toBe(true);
    expect(cronMatches("1-30/10 * * * *", d(2026, 7, 14, 5, 31))).toBe(false);
  });

  test("lists: 0 0 1,15 * *", () => {
    expect(cronMatches("0 0 1,15 * *", d(2026, 7, 1, 0, 0))).toBe(true);
    expect(cronMatches("0 0 1,15 * *", d(2026, 7, 15, 0, 0))).toBe(true);
    expect(cronMatches("0 0 1,15 * *", d(2026, 7, 14, 0, 0))).toBe(false);
  });

  test("dow 7 is Sunday, same as 0", () => {
    const sunday = d(2026, 7, 12, 8, 0);
    expect(cronMatches("0 8 * * 0", sunday)).toBe(true);
    expect(cronMatches("0 8 * * 7", sunday)).toBe(true);
  });

  test("month restriction", () => {
    expect(cronMatches("0 0 * 2 *", d(2026, 2, 10, 0, 0))).toBe(true);
    expect(cronMatches("0 0 * 2 *", d(2026, 3, 10, 0, 0))).toBe(false);
  });

  test("vixie OR rule: dom AND dow both restricted → either matches", () => {
    // 2026-07-14 is a Tuesday (dow 2), not the 1st.
    expect(cronMatches("0 0 1 * 2", d(2026, 7, 14, 0, 0))).toBe(true); // dow hit
    expect(cronMatches("0 0 1 * 3", d(2026, 7, 14, 0, 0))).toBe(false); // neither
    expect(cronMatches("0 0 14 * 3", d(2026, 7, 14, 0, 0))).toBe(true); // dom hit
  });

  test("invalid values throw", () => {
    expect(() => cronMatches("60 * * * *", new Date())).toThrow(/out of range/);
    expect(() => cronMatches("* * * * * *", new Date())).toThrow(/5-field/);
    expect(() => cronMatches("*/0 * * * *", new Date())).toThrow(/step/);
  });

  test("cronSchema accepts what cronMatches parses", () => {
    for (const expr of ["* * * * *", "0 9 * * 1-5", "*/15 * * * *", "0 0 1,15 * *"]) {
      expect(cronSchema.safeParse(expr).success).toBe(true);
    }
  });
});
