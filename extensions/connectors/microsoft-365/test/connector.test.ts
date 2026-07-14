import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { NotImplementedError } from "@lithis/stubkit";
import { manifest, microsoft365Connector } from "../src/index";

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

describe("microsoft-365 manifest (real data)", () => {
  test("validates against the ConnectorManifest contract", () => {
    expect(() => manifestSchema.parse(manifest)).not.toThrow();
  });

  test("declares oauth + mail/calendar/onedrive feeds", () => {
    expect(manifest.slug).toBe("microsoft-365");
    expect(manifest.authKind).toBe("oauth");
    expect(manifest.feeds.map((f) => f.key).sort()).toEqual([
      "calendar-events",
      "mail-messages",
      "onedrive-files",
    ]);
  });

  test("scopes are Microsoft Graph scopes", () => {
    const graphScopes = manifest.scopes.filter((s) => s.startsWith("https://graph.microsoft.com/"));
    expect(graphScopes.length).toBeGreaterThanOrEqual(3);
    expect(manifest.scopes).toContain("https://graph.microsoft.com/Mail.Read");
    expect(manifest.scopes).toContain("https://graph.microsoft.com/Files.Read.All");
  });
});

describe("microsoft-365 connector (stubs)", () => {
  test("sync throws NotImplementedError", () => {
    expect(invoke(microsoft365Connector.sync)).toThrow(NotImplementedError);
  });
  test("act throws NotImplementedError", () => {
    expect(invoke(microsoft365Connector.act)).toThrow(NotImplementedError);
  });
  test("health throws NotImplementedError", () => {
    expect(invoke(microsoft365Connector.health)).toThrow(NotImplementedError);
  });
});
