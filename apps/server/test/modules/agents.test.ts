import { describe, expect, test } from "bun:test";
import { expectStub } from "@lithis/evals";
import { newUlid } from "@lithis/core";
import {
  createToolBroker,
  createUnconfiguredAgentExecutor,
  createUnconfiguredAgentHost,
  readAgentMemory,
} from "../../src/agents";

/**
 * P7 made the agents module real; what remains here is the honesty surface:
 * the DB-less config degrades throw clear errors (not stubs — the real
 * implementation exists and wires whenever a database is configured), and the
 * memory-notebook gap stays a loud registered stub. Behavior lives in
 * test/agents.*.test.ts (executor/toolbroker units) and
 * test/integration/agents.pg.test.ts (the resident loop end-to-end).
 */

describe("agents DB-less config degrade", () => {
  test("host methods throw a clear configuration error", () => {
    const host = createUnconfiguredAgentHost();
    expect(() => host.ensure(newUlid())).toThrow(/DATABASE_URL is not set/);
    expect(() => host.wake(newUlid(), "manual")).toThrow(/DATABASE_URL is not set/);
    expect(() => host.status(newUlid())).toThrow(/DATABASE_URL is not set/);
  });

  test("executor throws a clear configuration error", () => {
    const executor = createUnconfiguredAgentExecutor();
    expect(() =>
      executor.execute(
        {
          tenantId: newUlid(),
          principalId: newUlid(),
          contextSlice: "x",
          budget: { usd: 1, maxMinutes: 1 },
        },
        new AbortController().signal,
      ),
    ).toThrow(/DATABASE_URL is not set/);
  });

  test("the tool broker is always real", () => {
    const broker = createToolBroker();
    const { tools } = broker.toolsFor({ tenantId: newUlid(), principalId: newUlid(), kind: "agent" });
    expect(tools.map((t) => t.name)).toContain("record_result");
  });
});

describe("agents remaining stubs", () => {
  test("memory notebook read is a loud registered stub", () => {
    const err = expectStub(() => readAgentMemory(newUlid(), newUlid()));
    expect(err.stubId).toBe("server.agents.host.memory");
    expect(err.reason).toStartWith("LITHIS-STUB:");
  });
});
