import { z } from "zod";

/** Crockford base32 alphabet (no I, L, O, U) — the ULID encoding. */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generate a ULID: 10 chars of millisecond timestamp + 16 chars of randomness.
 * Lexicographically sortable by creation time; dependency-free.
 */
export function newUlid(now: number = Date.now()): string {
  let time = now;
  let timeChars = "";
  for (let i = 0; i < 10; i++) {
    timeChars = ENCODING.charAt(time % 32) + timeChars;
    time = Math.floor(time / 32);
  }
  const rand = new Uint8Array(16);
  crypto.getRandomValues(rand);
  let randChars = "";
  for (let i = 0; i < 16; i++) {
    randChars += ENCODING.charAt((rand[i] ?? 0) % 32);
  }
  return timeChars + randChars;
}

export const ulidSchema = z.string().ulid();
export type Ulid = z.infer<typeof ulidSchema>;

export function isUlid(value: unknown): value is Ulid {
  return ulidSchema.safeParse(value).success;
}

/** ISO-8601 timestamp string — all lithis records serialize time this way. */
export const isoDateTimeSchema = z.string().datetime({ offset: true }).or(z.string().datetime());
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;

export function nowIso(): IsoDateTime {
  return new Date().toISOString();
}

/** 5-field cron expression (minute hour day-of-month month day-of-week). */
export const cronSchema = z
  .string()
  .regex(/^\s*(\S+\s+){4}\S+\s*$/, "expected a 5-field cron expression");
export type Cron = z.infer<typeof cronSchema>;
