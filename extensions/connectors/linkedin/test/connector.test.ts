import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { NotImplementedError } from "@lithis/stubkit";
import { linkedinConnector, manifest } from "../src/index";

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

describe("linkedin manifest (real data)", () => {
  test("validates against the ConnectorManifest contract", () => {
    expect(() => manifestSchema.parse(manifest)).not.toThrow();
  });

  test("declares browser_session auth + salesnav-search/profile feeds", () => {
    expect(manifest.slug).toBe("linkedin");
    expect(manifest.authKind).toBe("browser_session");
    expect(manifest.feeds.map((f) => f.key).sort()).toEqual(["profile", "salesnav-search"]);
  });

  test("connect/message actions carry the browser.linkedin.* capabilities", () => {
    expect(manifest.actions.map((a) => a.capability).sort()).toEqual([
      "browser.linkedin.connect",
      "browser.linkedin.message",
    ]);
  });

  test("has no oauth scopes — the sealed profile is the grant", () => {
    expect(manifest.scopes).toEqual([]);
  });
});

describe("linkedin connector (stubs)", () => {
  test("sync throws NotImplementedError", () => {
    expect(invoke(linkedinConnector.sync)).toThrow(NotImplementedError);
  });
  test("act throws NotImplementedError", () => {
    expect(invoke(linkedinConnector.act)).toThrow(NotImplementedError);
  });
  test("health throws NotImplementedError", () => {
    expect(invoke(linkedinConnector.health)).toThrow(NotImplementedError);
  });
});
