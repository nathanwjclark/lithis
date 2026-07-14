import { z } from "zod";
import type { Event } from "@lithis/core";
import { slugSchema } from "@lithis/core";
import { NotImplementedError, stub } from "@lithis/stubkit";

/**
 * @lithis/evals — eval harness CONTRACTS (cases, suites, verdicts, event-log
 * replay) plus the one fully-real helper the whole repo leans on in tests:
 * `expectStub()`, which asserts that a stubbed surface is loud.
 */

/** One eval case: an input (usually a fixture brief or event slice) + expectations. */
export const evalCaseSchema = z.object({
  id: slugSchema,
  description: z.string().min(1),
  input: z.unknown(),
  /** Expected output/behavior; interpretation belongs to the suite's checker. */
  expected: z.unknown().optional(),
  tags: z.array(z.string()).default([]),
});
export type EvalCase = z.infer<typeof evalCaseSchema>;

export const evalSuiteSchema = z.object({
  slug: slugSchema,
  description: z.string().min(1),
  /** What this suite exercises, e.g. a skill version or a connector. */
  subject: z.enum(["skill", "connector", "process", "agent"]),
  cases: z.array(evalCaseSchema).min(1),
});
export type EvalSuite = z.infer<typeof evalSuiteSchema>;

export const evalVerdictSchema = z.object({
  suiteSlug: slugSchema,
  caseId: slugSchema,
  pass: z.boolean(),
  /** Optional graded score in [0,1] for rubric-style checks. */
  score: z.number().min(0).max(1).optional(),
  detail: z.string().optional(),
});
export type EvalVerdict = z.infer<typeof evalVerdictSchema>;

/**
 * Replays a recorded event-log slice against a suite — the spine doubles as
 * the eval substrate (design principle 3). Stubbed until the spine exists.
 */
export interface ReplayHarness {
  /** Load the recorded events the replay runs over. */
  load(events: Event[]): Promise<void>;
  /** Run a suite against the loaded log; one verdict per case. */
  run(suite: EvalSuite): Promise<EvalVerdict[]>;
}

export const createReplayHarness = stub<() => ReplayHarness>(
  "evals.replay.harness",
  "LITHIS-STUB: event-log replay harness not implemented — needs the spine (readSince) and executor to exist",
);

/**
 * Invoke `fn` and assert it throws stubkit's NotImplementedError; returns the
 * error so callers can assert on stubId/reason. Fully implemented — this is
 * how every package tests that its stubbed surfaces are loud.
 *
 * Stubs throw synchronously (even Promise-typed ones), so a returned value —
 * including a Promise — means the surface is NOT a stub, and expectStub fails.
 */
export function expectStub(fn: () => unknown): NotImplementedError {
  let returned: unknown;
  try {
    returned = fn();
  } catch (error) {
    if (error instanceof NotImplementedError) return error;
    const shown = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(`expectStub: expected NotImplementedError, but it threw ${shown}`);
  }
  throw new Error(
    `expectStub: expected NotImplementedError, but the function returned ${
      returned instanceof Promise ? "a Promise" : String(returned)
    } — this surface is not a registered stub`,
  );
}
