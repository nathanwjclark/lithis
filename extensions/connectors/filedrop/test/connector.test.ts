import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { NotImplementedError } from "@lithis/stubkit";
import { filedropConnector, manifest } from "../src/index";

/** Local mirror of the shared ConnectorManifest contract (@lithis/sdk). */
const manifestSchema = z.object({
  slug: z.string().min(1),
  displayName: z.string().min(1),
  authKind: z.enum(["oauth", "api_key", "browser_session", "ssh"]),
  feeds: z.array(
    z.object({ key: z.string().min(1), description: z.string().min(1), docTypes: z.array(z.string().min(1)).min(1) }),
  ),
  actions: z.array(
    z.object({ key: z.string().min(1), capability: z.string().min(1), description: z.string().min(1) }),
  ),
  scopes: z.array(z.string().min(1)),
});

const invoke = (fn: unknown) => () => (fn as () => unknown)();

describe("filedrop manifest (real data)", () => {
  test("validates against the ConnectorManifest contract", () => {
    expect(() => manifestSchema.parse(manifest)).not.toThrow();
  });

  test("declares ssh auth and a watched-path feed", () => {
    expect(manifest.slug).toBe("filedrop");
    expect(manifest.authKind).toBe("ssh");
    expect(manifest.feeds.map((f) => f.key)).toEqual(["watched-path"]);
    expect(manifest.feeds[0]?.docTypes).toEqual(["file_drop"]);
  });

  test("is ingest-only: no actions, no oauth scopes", () => {
    expect(manifest.actions).toEqual([]);
    expect(manifest.scopes).toEqual([]);
  });
});

describe("filedrop connector (stubs)", () => {
  test("sync throws NotImplementedError", () => {
    expect(invoke(filedropConnector.sync)).toThrow(NotImplementedError);
  });
  test("act throws NotImplementedError", () => {
    expect(invoke(filedropConnector.act)).toThrow(NotImplementedError);
  });
  test("health throws NotImplementedError", () => {
    expect(invoke(filedropConnector.health)).toThrow(NotImplementedError);
  });
});
