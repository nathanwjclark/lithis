import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { NotImplementedError } from "@lithis/stubkit";
import { githubConnector, manifest } from "../src/index";

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

describe("github manifest (real data)", () => {
  test("validates against the ConnectorManifest contract", () => {
    expect(() => manifestSchema.parse(manifest)).not.toThrow();
  });

  test("declares api_key auth + repos/issues/prs feeds", () => {
    expect(manifest.slug).toBe("github");
    expect(manifest.authKind).toBe("api_key");
    expect(manifest.feeds.map((f) => f.key).sort()).toEqual(["issues", "prs", "repos"]);
  });

  test("declares the issue.create action", () => {
    expect(manifest.actions.map((a) => a.key)).toEqual(["issue.create"]);
    expect(manifest.actions[0]?.capability).toBe("github.issue.create");
  });
});

describe("github connector (stubs)", () => {
  test("sync throws NotImplementedError", () => {
    expect(invoke(githubConnector.sync)).toThrow(NotImplementedError);
  });
  test("act throws NotImplementedError", () => {
    expect(invoke(githubConnector.act)).toThrow(NotImplementedError);
  });
  test("health throws NotImplementedError", () => {
    expect(invoke(githubConnector.health)).toThrow(NotImplementedError);
  });
});
