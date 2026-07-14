import { describe, expect, test } from "bun:test";
import { countDueMisses, MAX_SCAN_MINUTES } from "../src/connections/expectations";

const T = (iso: string): Date => new Date(iso);

describe("countDueMisses (grace-window math)", () => {
  test("no fires between base and now → nothing missed", () => {
    expect(countDueMisses("0 9 * * *", T("2026-01-01T10:00:00Z"), T("2026-01-01T12:00:00Z"), 30)).toBe(0);
  });

  test("a fire is missed only once its grace window fully elapses", () => {
    const base = T("2026-01-01T00:00:00Z");
    // daily 09:00 UTC fire, 60 min grace (times below in UTC via Z dates —
    // cron evaluates in the runtime's local time, so pin via env TZ=UTC in CI
    // or use minute-level cadences; here we use an every-minute cadence to
    // stay timezone-proof).
    expect(countDueMisses("* * * * *", base, T("2026-01-01T00:03:30Z"), 2)).toBe(1); // 00:01 (deadline 00:03) only
    expect(countDueMisses("* * * * *", base, T("2026-01-01T00:04:00Z"), 2)).toBe(2); // + 00:02
  });

  test("every-minute cadence with zero grace counts each elapsed fire", () => {
    const base = T("2026-01-01T00:00:00Z");
    expect(countDueMisses("* * * * *", base, T("2026-01-01T00:05:30Z"), 0)).toBe(5);
  });

  test("fires strictly after base — the arrival minute itself is not re-counted", () => {
    const base = T("2026-01-01T00:03:00Z");
    expect(countDueMisses("* * * * *", base, T("2026-01-01T00:04:00Z"), 0)).toBe(1); // only 00:04
  });

  test("mid-minute base still excludes the fire preceding it", () => {
    const base = T("2026-01-01T00:03:30Z");
    expect(countDueMisses("* * * * *", base, T("2026-01-01T00:05:00Z"), 0)).toBe(2); // 00:04, 00:05
  });

  test("grace pushes the whole window: nothing missed while within grace", () => {
    const base = T("2026-01-01T00:00:00Z");
    expect(countDueMisses("* * * * *", base, T("2026-01-01T00:05:00Z"), 10)).toBe(0);
  });

  test("scan never walks further back than MAX_SCAN_MINUTES", () => {
    const base = T("2000-01-01T00:00:00Z"); // decades ago
    const now = T("2026-01-01T00:00:00Z");
    // hourly on the hour: bounded by the cap, not by 26 years of minutes
    const missed = countDueMisses("0 * * * *", base, now, 0);
    expect(missed).toBeLessThanOrEqual(MAX_SCAN_MINUTES / 60 + 1);
    expect(missed).toBeGreaterThan(0);
  });
});
