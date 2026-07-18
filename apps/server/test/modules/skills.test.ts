import { describe, expect, test } from "bun:test";
import { NotImplementedError } from "@lithis/stubkit";
import { createUnconfiguredSkillRegistry, runEvalGate } from "../../src/skills";

/**
 * P10-skills replaced the registry stub with the real service (covered by
 * test/skills.runtime.test.ts, test/skills.tick.test.ts and
 * test/integration/skills.pg.test.ts). What remains here: the DB-less config
 * degrade and the deliberately-registered P16 eval-gate stub.
 */

describe("skills module surface", () => {
  test("DB-less skeleton mode: the unconfigured registry fails loudly, not silently", () => {
    const registry = createUnconfiguredSkillRegistry();
    expect(() => registry.list("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toThrow(/DATABASE_URL is not set/);
    expect(() =>
      registry.forPrincipal({
        tenantId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        principalId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        kind: "human",
      }),
    ).toThrow(/DATABASE_URL is not set/);
  });

  test("the eval gate is a loud registered stub (P16-evals pending), never a silent pass", () => {
    expect(() => runEvalGate("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toThrow(NotImplementedError);
    try {
      runEvalGate("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    } catch (err) {
      expect((err as NotImplementedError).stubId).toBe("server.skills.registry.evalgate");
      expect((err as NotImplementedError).reason).toStartWith("LITHIS-STUB:");
    }
  });
});
