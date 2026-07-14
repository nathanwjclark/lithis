import { describe, expect, test } from "bun:test";
import { connectionSchema, newUlid, nowIso } from "@lithis/core";
import type { Connection } from "@lithis/core";
import { defineConnector } from "@lithis/sdk/connectors";
import type { ConnectorHooks, ConnectorManifest } from "@lithis/sdk/connectors";
import { createConnectorRuntime } from "../src/connections";
import type { ConnectorAuthProvider } from "../src/connections";

const manifest = (slug: string): ConnectorManifest => ({
  slug,
  displayName: slug,
  authKind: "api_key",
  feeds: [{ key: `${slug}:items`, description: "test feed", docTypes: ["message"] }],
  actions: [],
  scopes: [],
});

const hooks: ConnectorHooks = {
  sync: async () => "cursor-1",
  act: async () => ({ ok: true }),
  health: async () => ({ ok: true }),
};

const provider: ConnectorAuthProvider = {
  getAuth: async () => ({ kind: "api_key", token: "bkr_fake", expiresAt: nowIso() }),
  redeem: async () => "fixture-secret",
};

function fakeConnection(slug: string): Connection {
  const at = nowIso();
  return connectionSchema.parse({
    id: newUlid(),
    tenantId: newUlid(),
    connectorSlug: slug,
    displayName: slug,
    credentialRef: newUlid(),
    scopes: [],
    status: "healthy",
    health: {},
    syncState: { cursorsByFeed: {} },
    createdAt: at,
    updatedAt: at,
  });
}

describe("ConnectorRuntime (registration seam)", () => {
  test("registers plain connectors and resolves by manifest slug", () => {
    const runtime = createConnectorRuntime(provider);
    const connector = runtime.register(defineConnector(manifest("fake-slack"), hooks));
    expect(runtime.resolve("fake-slack")).toBe(connector);
    expect(runtime.resolve("unknown")).toBeUndefined();
    expect(runtime.slugs()).toEqual(["fake-slack"]);
  });

  test("factory registrations receive the ConnectorAuthProvider", () => {
    const runtime = createConnectorRuntime(provider);
    let received: ConnectorAuthProvider | undefined;
    runtime.register((auth) => {
      received = auth;
      return defineConnector(manifest("fake-google"), hooks);
    });
    expect(received).toBe(provider);
    expect(runtime.slugs()).toEqual(["fake-google"]);
  });

  test("duplicate slugs are rejected loudly", () => {
    const runtime = createConnectorRuntime(provider);
    runtime.register(defineConnector(manifest("fake-slack"), hooks));
    expect(() => runtime.register(defineConnector(manifest("fake-slack"), hooks))).toThrow(
      /already registered/,
    );
  });

  test("probeFor wraps the registered connector's health hook", async () => {
    const runtime = createConnectorRuntime(provider);
    runtime.register(
      defineConnector(manifest("fake-slack"), {
        ...hooks,
        health: async () => ({ ok: false, error: "token revoked" }),
      }),
    );
    const probe = runtime.probeFor(fakeConnection("fake-slack"));
    expect(probe).toBeDefined();
    expect(await probe!.probe(fakeConnection("fake-slack"))).toEqual({
      ok: false,
      error: "token revoked",
    });
    expect(runtime.probeFor(fakeConnection("never-registered"))).toBeUndefined();
  });
});
