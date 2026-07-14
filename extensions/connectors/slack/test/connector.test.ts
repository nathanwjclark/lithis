import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { NotImplementedError } from "@lithis/stubkit";
import { manifest, slackConnector } from "../src/index";

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

describe("slack manifest (real data)", () => {
  test("validates against the ConnectorManifest contract", () => {
    expect(() => manifestSchema.parse(manifest)).not.toThrow();
  });

  test("declares oauth, the channel-messages feed, and the chat.write action", () => {
    expect(manifest.slug).toBe("slack");
    expect(manifest.authKind).toBe("oauth");
    expect(manifest.feeds.map((f) => f.key)).toEqual(["channel-messages"]);
    expect(manifest.actions.map((a) => a.key)).toEqual(["chat.write"]);
    expect(manifest.actions[0]?.capability).toBe("slack.chat.write");
  });

  test("scopes include real Slack bot scopes", () => {
    expect(manifest.scopes).toContain("chat:write");
    expect(manifest.scopes).toContain("channels:history");
  });
});

describe("slack connector (stubs)", () => {
  test("sync throws NotImplementedError", () => {
    expect(invoke(slackConnector.sync)).toThrow(NotImplementedError);
  });
  test("act throws NotImplementedError", () => {
    expect(invoke(slackConnector.act)).toThrow(NotImplementedError);
  });
  test("health throws NotImplementedError", () => {
    expect(invoke(slackConnector.health)).toThrow(NotImplementedError);
  });
});
