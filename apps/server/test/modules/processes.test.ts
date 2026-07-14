// processes is REAL as of phase P8 — behavioral coverage lives in
// test/processes.invalidator.test.ts (pure planning/matching) and
// test/integration/processes.pg.test.ts (instantiate + live cascades).
// This file asserts exactly which loud seams remain stubbed.
import { expect, test } from "bun:test";
import { NotImplementedError, isStub } from "@lithis/stubkit";
import {
  createUnconfiguredProcessEngine,
  stubInterpretAssertion,
  stubRunResultPort,
} from "../../src/processes";

test("processes keeps exactly two stubs: the P7 RunResult port and interpret-mode watches", () => {
  expect(isStub(stubRunResultPort.supersede)).toBe(true);
  expect(isStub(stubInterpretAssertion)).toBe(true);
});

test("the default RunResultPort throws loudly until P7 wires the real store", () => {
  try {
    stubRunResultPort.supersede("t", "w");
    throw new Error("expected NotImplementedError");
  } catch (err) {
    expect(err).toBeInstanceOf(NotImplementedError);
    expect((err as NotImplementedError).stubId).toBe("server.processes.results.supersede");
    expect((err as NotImplementedError).reason).toStartWith("LITHIS-STUB:");
  }
});

test("DB-less skeleton mode degrades honestly (config error, not a stub)", () => {
  const engine = createUnconfiguredProcessEngine();
  expect(() => engine.getRun("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toThrow(/DATABASE_URL is not set/);
});
