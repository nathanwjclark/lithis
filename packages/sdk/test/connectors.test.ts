import { describe, expect, test } from "bun:test";
import { newUlid } from "@lithis/core";
import type { ActionReceipt, IngestSink, NewDocInput } from "../src/connectors";
import { connectorManifestSchema, defineConnector } from "../src/connectors";
import { connectorOrigin, validConnection, validManifest } from "./fixtures";

describe("connectorManifestSchema", () => {
  test("round-trips a valid manifest", () => {
    const manifest = validManifest();
    const parsed = connectorManifestSchema.parse(manifest);
    expect(parsed).toEqual(manifest);
  });

  test("accepts every auth kind from the contract", () => {
    for (const authKind of ["oauth", "api_key", "browser_session", "ssh"] as const) {
      expect(connectorManifestSchema.parse({ ...validManifest(), authKind }).authKind).toBe(
        authKind,
      );
    }
  });

  test("rejects an unknown authKind", () => {
    const bad = { ...validManifest(), authKind: "kerberos" };
    expect(() => connectorManifestSchema.parse(bad)).toThrow();
  });

  test("rejects a non-slug connector slug", () => {
    const bad = { ...validManifest(), slug: "Carrier Portal!" };
    expect(() => connectorManifestSchema.parse(bad)).toThrow();
  });

  test("rejects an action capability that is not dot-namespaced", () => {
    const manifest = validManifest();
    const bad = {
      ...manifest,
      actions: [{ ...manifest.actions[0]!, capability: "submitform" }],
    };
    expect(() => connectorManifestSchema.parse(bad)).toThrow();
  });

  test("rejects a manifest missing feeds", () => {
    const { feeds: _feeds, ...withoutFeeds } = validManifest();
    expect(() => connectorManifestSchema.parse(withoutFeeds)).toThrow();
  });
});

describe("defineConnector", () => {
  test("validates the manifest and returns it with the hooks", async () => {
    const seen: string[] = [];
    const receipt: ActionReceipt = { ok: true, externalId: "ext-1" };
    const connector = defineConnector(validManifest(), {
      sync: async (_connection, feed, cursor, _sink) => {
        seen.push(`sync:${feed}:${cursor ?? "start"}`);
        return "cursor-2";
      },
      act: async (_connection, action, _auth) => {
        seen.push(`act:${action.key}`);
        return receipt;
      },
      health: async () => ({ ok: true }),
    });

    expect(connector.manifest).toEqual(validManifest());

    const sink: IngestSink = {
      putBlob: async (input) => ({ kind: "blob", id: newUlid() }),
      ingestDoc: async (_input: NewDocInput) => ({ kind: "doc", id: newUlid() }),
    };
    const connection = validConnection();
    await expect(connector.sync(connection, "portal:loss-runs", null, sink)).resolves.toBe(
      "cursor-2",
    );
    await expect(
      connector.act(
        connection,
        { key: "submit_form", params: { quoteId: "q-1" }, intentId: newUlid() },
        { kind: "browser_session" },
      ),
    ).resolves.toEqual(receipt);
    await expect(connector.health(connection)).resolves.toEqual({ ok: true });
    expect(seen).toEqual(["sync:portal:loss-runs:start", "act:submit_form"]);
  });

  test("throws on an invalid manifest before any hook can run", () => {
    const bad = { ...validManifest(), displayName: "" };
    expect(() =>
      defineConnector(bad, {
        sync: async () => "cursor",
        act: async () => ({ ok: true }),
        health: async () => ({ ok: true }),
      }),
    ).toThrow();
  });

  test("sink inputs are typed against @lithis/core shapes", () => {
    // Compile-time contract exercised with a fixture: NewDocInput picks core Doc fields.
    const doc: NewDocInput = {
      type: "loss_run",
      slug: "acme-loss-run-2026",
      title: "Acme loss run 2026",
      bodyBlobId: newUlid(),
      frontmatter: { carrier: "acme" },
      origin: connectorOrigin(),
    };
    expect(doc.type).toBe("loss_run");
  });
});
