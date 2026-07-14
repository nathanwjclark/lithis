// custody is PARTIALLY real as of P3-connect: getBrokered/issueFor/redeem are
// implemented (see test/integration/custody.pg.test.ts); mountSession remains
// a loud stub until browserhost lands (P12). This file keeps the census honest.
// (Census assertions are absence-only — stubkit's own suite resets the global
// registry mid-process, so exact-set equality would be file-order-fragile.)
import { expect, test } from "bun:test";
import { newUlid } from "@lithis/core";
import { expectStub } from "@lithis/evals";
import { StubRegistry } from "@lithis/stubkit";
import { createCustody } from "../../src/custody";
import type { Db } from "../../src/db";
import type { EventSpine } from "../../src/spine";

test("no custody stub other than mountSession exists — the broker is implemented", () => {
  const unexpected = StubRegistry.census()
    .records.map((r) => r.id)
    .filter((id) => id.startsWith("server.custody.") && id !== "server.custody.broker.mountSession");
  expect(unexpected).toEqual([]);
});

test("mountSession() still throws NotImplementedError with its stub id", () => {
  const custody = createCustody({
    db: {} as Db, // never reached — mountSession throws before any dependency use
    spine: {} as EventSpine,
    credentials: { get: async () => null },
    backend: {
      getSecret: async () => {
        throw new Error("unreachable in this test");
      },
    },
  });
  const err = expectStub(() => custody.mountSession(newUlid(), { podId: "pod-1" }));
  expect(err.stubId).toBe("server.custody.broker.mountSession");
  expect(err.reason).toStartWith("LITHIS-STUB:");
});
