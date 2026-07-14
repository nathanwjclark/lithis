import { describe, expect, test } from "bun:test";
import { cronSchema, isUlid, newUlid, ulidSchema } from "@lithis/core";

describe("ULID", () => {
  test("generates valid 26-char Crockford ULIDs", () => {
    const id = newUlid();
    expect(id).toHaveLength(26);
    expect(ulidSchema.safeParse(id).success).toBe(true);
    expect(isUlid(id)).toBe(true);
  });

  test("is unique across many generations", () => {
    const seen = new Set(Array.from({ length: 5000 }, () => newUlid()));
    expect(seen.size).toBe(5000);
  });

  test("sorts by generation time across millisecond boundaries", () => {
    const early = newUlid(1_000_000_000_000);
    const late = newUlid(1_000_000_100_000);
    expect(early < late).toBe(true);
  });

  test("rejects non-ulids", () => {
    expect(isUlid("not-a-ulid")).toBe(false);
    expect(isUlid("")).toBe(false);
  });
});

describe("cron", () => {
  test("accepts 5-field expressions", () => {
    expect(cronSchema.safeParse("30 5 * * *").success).toBe(true);
    expect(cronSchema.safeParse("*/15 6-23 * * 1-5").success).toBe(true);
  });

  test("rejects non-cron strings", () => {
    expect(cronSchema.safeParse("every day at 5").success).toBe(false);
    expect(cronSchema.safeParse("30 5 * *").success).toBe(false);
  });
});
