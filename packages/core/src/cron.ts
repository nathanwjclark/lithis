import type { Cron } from "./ids";

/**
 * Pure 5-field cron evaluation (minute hour day-of-month month day-of-week).
 * Supports `*`, lists (`1,15`), ranges (`1-5`), and `/n` steps (over `*` or a
 * range). Day-of-week: 0 or 7 = Sunday. Standard cron OR-semantics apply when BOTH
 * day-of-month and day-of-week are restricted: the date matches if either
 * field matches. Evaluation is in the local time of the caller's Date.
 *
 * The clock's TickSources use this to answer "does this schedule fire at this
 * minute?" — deterministic and unit-testable, no scheduling state here.
 */

interface FieldSpec {
  min: number;
  max: number;
}

const FIELDS: FieldSpec[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week (0 and 7 are Sunday)
];

function parseField(field: string, spec: FieldSpec): Set<number> | "any" {
  if (field === "*") return "any";
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart !== undefined ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`invalid cron step '${part}'`);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*" || rangePart === "") {
      lo = spec.min;
      hi = spec.max;
    } else if (rangePart !== undefined && rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangePart);
      hi = stepPart !== undefined ? spec.max : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < spec.min || hi > spec.max || lo > hi) {
      throw new Error(`cron field value '${part}' out of range ${spec.min}-${spec.max}`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

function matches(parsed: Set<number> | "any", value: number): boolean {
  return parsed === "any" || parsed.has(value);
}

/** How many minutes ahead cronNext scans before giving up (60 days). */
const CRON_NEXT_SCAN_MINUTES = 60 * 24 * 60;

/**
 * The next minute strictly after `after` at which the expression fires, or
 * undefined when nothing matches within the (bounded) 60-day scan window —
 * enough for any real cadence; a cron that cannot fire for two months is
 * treated as never-firing rather than looping forever. Minute-stepping over
 * cronMatches keeps this trivially consistent with the tick sources.
 */
export function cronNext(expr: Cron, after: Date): Date | undefined {
  const base = new Date(after);
  base.setSeconds(0, 0);
  for (let i = 1; i <= CRON_NEXT_SCAN_MINUTES; i++) {
    const candidate = new Date(base.getTime() + i * 60_000);
    if (cronMatches(expr, candidate)) return candidate;
  }
  return undefined;
}

/** Does this cron expression fire at this date's minute? */
export function cronMatches(expr: Cron, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`expected a 5-field cron expression, got '${expr}'`);
  }
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f!, FIELDS[i]!));

  const domRestricted = fields[2] !== "*";
  const dowRestricted = fields[4] !== "*";

  if (!matches(minute!, date.getMinutes())) return false;
  if (!matches(hour!, date.getHours())) return false;
  if (!matches(month!, date.getMonth() + 1)) return false;

  const domHit = matches(dom!, date.getDate());
  const weekday = date.getDay(); // 0=Sunday
  const dowHit = matches(dow!, weekday) || (weekday === 0 && matches(dow!, 7));

  // Vixie-cron rule: both restricted → OR; otherwise both must match.
  if (domRestricted && dowRestricted) return domHit || dowHit;
  return domHit && dowHit;
}
