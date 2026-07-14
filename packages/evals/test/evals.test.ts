import { describe, expect, test } from "bun:test";
import { NotImplementedError, stub } from "@lithis/stubkit";
import {
  createReplayHarness,
  evalCaseSchema,
  evalSuiteSchema,
  evalVerdictSchema,
  expectStub,
} from "../src/index";

const validCase = {
  id: "loss-run-retrigger",
  description: "New loss-run doc invalidates the rating node",
  input: { docType: "loss_run", nodeKey: "rate" },
  expected: { staleNodes: ["rate", "quote"] },
  tags: ["invalidation"],
};

describe("eval schemas", () => {
  test("round-trips a valid case (tags default applied elsewhere)", () => {
    const parsed = evalCaseSchema.parse(validCase);
    expect(parsed).toEqual(validCase);
  });

  test("defaults tags to []", () => {
    const { tags: _tags, ...withoutTags } = validCase;
    expect(evalCaseSchema.parse(withoutTags).tags).toEqual([]);
  });

  test("round-trips a valid suite and rejects an empty one", () => {
    const suite = {
      slug: "underwriting-invalidation",
      description: "Cascade behavior for the UW process",
      subject: "process" as const,
      cases: [validCase],
    };
    expect(evalSuiteSchema.parse(suite).cases).toHaveLength(1);
    expect(() => evalSuiteSchema.parse({ ...suite, cases: [] })).toThrow();
  });

  test("rejects a suite with an unknown subject", () => {
    expect(() =>
      evalSuiteSchema.parse({
        slug: "s",
        description: "d",
        subject: "vibes",
        cases: [validCase],
      }),
    ).toThrow();
  });

  test("verdict round-trips and bounds score to [0,1]", () => {
    const verdict = {
      suiteSlug: "underwriting-invalidation",
      caseId: "loss-run-retrigger",
      pass: true,
      score: 0.8,
      detail: "both nodes went stale",
    };
    expect(evalVerdictSchema.parse(verdict)).toEqual(verdict);
    expect(() => evalVerdictSchema.parse({ ...verdict, score: 1.2 })).toThrow();
  });
});

describe("expectStub", () => {
  test("returns the NotImplementedError from a real stub", () => {
    const sample = stub<() => Promise<string>>(
      "evals.test.sample",
      "LITHIS-STUB: fixture stub used to test expectStub itself",
    );
    const error = expectStub(() => sample());
    expect(error).toBeInstanceOf(NotImplementedError);
    expect(error.stubId).toBe("evals.test.sample");
    expect(error.reason).toStartWith("LITHIS-STUB:");
  });

  test("fails when the function returns instead of throwing", () => {
    expect(() => expectStub(() => 42)).toThrow(/returned 42/);
  });

  test("fails when the function returns a Promise (async non-stub)", () => {
    expect(() => expectStub(() => Promise.resolve("ok"))).toThrow(/returned a Promise/);
  });

  test("fails when the function throws something else", () => {
    expect(() =>
      expectStub(() => {
        throw new RangeError("out of range");
      }),
    ).toThrow(/RangeError: out of range/);
  });
});

describe("createReplayHarness (stub)", () => {
  test("throws NotImplementedError with the registered stub id", () => {
    const error = expectStub(() => createReplayHarness());
    expect(error.stubId).toBe("evals.replay.harness");
  });
});
