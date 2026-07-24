// custody is fully real as of P12-browser: getBrokered/issueFor/redeem landed
// with P3-connect (test/integration/custody.pg.test.ts) and mountSession with
// P12 (test/integration/browser.pg.test.ts). This file keeps the census honest
// and pins the honest-degrade behavior when browser sessions are unconfigured.
// (Census assertions are absence-only — stubkit's own suite resets the global
// registry mid-process, so exact-set equality would be file-order-fragile.)
import { expect, test } from "bun:test";
import { newUlid } from "@lithis/core";
import type { PrincipalContext } from "@lithis/core";
import { StubRegistry } from "@lithis/stubkit";
import {
  BROWSER_PROFILE_REF_PREFIX,
  createCustody,
  createLocalBrowserProfileStore,
  profileKeyFromRef,
} from "../../src/custody";
import type { Db } from "../../src/db";
import type { EventSpine } from "../../src/spine";

test("no custody stubs remain — the broker and sealed-session mounting are implemented", () => {
  const remaining = StubRegistry.census()
    .records.map((r) => r.id)
    .filter((id) => id.startsWith("server.custody."));
  expect(remaining).toEqual([]);
});

test("mountSession degrades honestly (not silently) when browser sessions are unconfigured", () => {
  const custody = createCustody({
    db: {} as Db, // never reached — the config check fires first
    spine: {} as EventSpine,
    credentials: { get: async () => null },
    backend: {
      getSecret: async () => {
        throw new Error("unreachable in this test");
      },
    },
  });
  const p: PrincipalContext = { tenantId: newUlid(), principalId: newUlid(), kind: "human" };
  expect(() => custody.mountSession(newUlid(), p)).toThrow(/sealed browser sessions unavailable/);
});

test("browser profile refs are validated, never guessed", () => {
  expect(profileKeyFromRef(`${BROWSER_PROFILE_REF_PREFIX}linkedin-main`)).toBe("linkedin-main");
  expect(() => profileKeyFromRef("env-file:SLACK_BOT_TOKEN")).toThrow(/not a browser profile/);
  expect(() => profileKeyFromRef(`${BROWSER_PROFILE_REF_PREFIX}../../etc`)).toThrow(/malformed/);
  expect(() => profileKeyFromRef(BROWSER_PROFILE_REF_PREFIX)).toThrow(/malformed/);
});

test("resolving a profile that was never seeded fails loudly", async () => {
  const store = createLocalBrowserProfileStore("/tmp/lithis-test-profiles-does-not-exist");
  await expect(store.resolve(`${BROWSER_PROFILE_REF_PREFIX}nope`)).rejects.toThrow(
    /no sealed browser profile at/,
  );
});
