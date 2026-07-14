import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { NotImplementedError } from "@lithis/stubkit";
import { googleWorkspaceConnector, manifest } from "../src/index";

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

describe("google-workspace manifest (real data)", () => {
  test("validates against the ConnectorManifest contract", () => {
    expect(() => manifestSchema.parse(manifest)).not.toThrow();
  });

  test("declares oauth + the three Workspace feeds", () => {
    expect(manifest.slug).toBe("google-workspace");
    expect(manifest.authKind).toBe("oauth");
    expect(manifest.feeds.map((f) => f.key).sort()).toEqual([
      "calendar-events",
      "drive-files",
      "gmail-messages",
    ]);
  });

  test("declares gmail.send and calendar.create actions", () => {
    expect(manifest.actions.map((a) => a.capability).sort()).toEqual(["calendar.create", "gmail.send"]);
  });

  test("scopes are actual Google OAuth scope URLs, readonly for feeds", () => {
    for (const scope of manifest.scopes) {
      expect(scope).toStartWith("https://www.googleapis.com/auth/");
    }
    expect(manifest.scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(manifest.scopes).toContain("https://www.googleapis.com/auth/calendar.readonly");
    expect(manifest.scopes).toContain("https://www.googleapis.com/auth/drive.readonly");
  });
});

describe("google-workspace connector (stubs)", () => {
  test("sync throws NotImplementedError", () => {
    expect(invoke(googleWorkspaceConnector.sync)).toThrow(NotImplementedError);
  });
  test("act throws NotImplementedError", () => {
    expect(invoke(googleWorkspaceConnector.act)).toThrow(NotImplementedError);
  });
  test("health throws NotImplementedError", () => {
    expect(invoke(googleWorkspaceConnector.health)).toThrow(NotImplementedError);
  });
});
