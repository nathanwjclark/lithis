import { describe, expect, test } from "bun:test";
import { newUlid } from "@lithis/core";
import type { Connector } from "@lithis/sdk/connectors";
import { actionBatchPayloadSchema, resolveCapability } from "../src/iam";
import { createConnectorRuntime } from "../src/connections";
import type { ConnectorAuthProvider } from "../src/connections";

/**
 * Pure surfaces of the ActionIntent batch machinery. The Postgres behavior
 * (propose → gate → verdicts → execute → receipts) is covered in
 * test/integration/browser.pg.test.ts.
 */

function connector(slug: string, actions: { key: string; capability: string }[]): Connector {
  return {
    manifest: {
      slug,
      displayName: slug,
      authKind: "browser_session",
      feeds: [],
      actions: actions.map((a) => ({ ...a, description: `${a.key} on ${slug}` })),
      scopes: [],
    },
    sync: async () => "",
    act: async () => ({ ok: true }),
    health: async () => ({ ok: true }),
  };
}

const noAuth: ConnectorAuthProvider = {
  getAuth: async () => ({ kind: "browser_session" }),
  redeem: async () => {
    throw new Error("not exercised");
  },
};

describe("actionBatchPayloadSchema (the pinned action_batch payload)", () => {
  const base = {
    batchId: newUlid(),
    proposedBy: { kind: "principal", id: newUlid() },
    principalId: newUlid(),
    items: [
      {
        intentId: newUlid(),
        capability: "browser.linkedin.connect",
        summary: "Connect with Jane Roe",
      },
    ],
  };

  test("accepts a well-formed batch", () => {
    expect(() => actionBatchPayloadSchema.parse(base)).not.toThrow();
  });

  test("every item needs a human-readable summary — a reviewer must see what they approve", () => {
    expect(
      actionBatchPayloadSchema.safeParse({
        ...base,
        items: [{ intentId: newUlid(), capability: "browser.linkedin.connect", summary: "" }],
      }).success,
    ).toBe(false);
  });

  test("rejects empty batches and malformed capabilities", () => {
    expect(actionBatchPayloadSchema.safeParse({ ...base, items: [] }).success).toBe(false);
    expect(
      actionBatchPayloadSchema.safeParse({
        ...base,
        items: [{ intentId: newUlid(), capability: "NotACapability", summary: "x" }],
      }).success,
    ).toBe(false);
  });

  test("carries the counterpart ref so denials have something to point at", () => {
    const entity = { kind: "entity", id: newUlid() } as const;
    const parsed = actionBatchPayloadSchema.parse({
      ...base,
      items: [{ ...base.items[0]!, counterpartRef: entity }],
    });
    expect(parsed.items[0]!.counterpartRef).toEqual(entity);
  });
});

describe("resolveCapability (capability → connector action)", () => {
  test("finds the single connector action declaring the capability", () => {
    const runtime = createConnectorRuntime(noAuth);
    runtime.register(
      connector("linkedin", [
        { key: "connect", capability: "browser.linkedin.connect" },
        { key: "message", capability: "browser.linkedin.message" },
      ]),
    );
    runtime.register(connector("slack", [{ key: "chat.write", capability: "slack.chat.write" }]));
    expect(resolveCapability(runtime, "browser.linkedin.message")).toEqual({
      connectorSlug: "linkedin",
      actionKey: "message",
    });
  });

  test("an unknown capability fails loudly instead of guessing", () => {
    const runtime = createConnectorRuntime(noAuth);
    runtime.register(connector("slack", [{ key: "chat.write", capability: "slack.chat.write" }]));
    expect(() => resolveCapability(runtime, "browser.linkedin.connect")).toThrow(
      /no registered connector declares the capability/,
    );
  });

  test("an ambiguous capability refuses to pick a connector", () => {
    const runtime = createConnectorRuntime(noAuth);
    runtime.register(connector("linkedin", [{ key: "connect", capability: "browser.linkedin.connect" }]));
    runtime.register(connector("linkedin-alt", [{ key: "connect", capability: "browser.linkedin.connect" }]));
    expect(() => resolveCapability(runtime, "browser.linkedin.connect")).toThrow(
      /refusing to guess which one acts/,
    );
  });
});
