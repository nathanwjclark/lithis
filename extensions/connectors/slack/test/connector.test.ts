import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ZodError } from "zod";
import { createSlackConnector, manifest } from "../src/index";
import {
  FAKE_BOT_TOKEN,
  FAKE_BROKER_TOKEN,
  fakeAuthProvider,
  fakeConnection,
  fakeSlackFetch,
} from "./helpers/fake-slack";
import authTestOk from "./fixtures/auth.test.ok.json";
import authTestInvalid from "./fixtures/auth.test.invalid.json";
import chatPostOk from "./fixtures/chat.postMessage.ok.json";
import chatPostChannelNotFound from "./fixtures/chat.postMessage.channel_not_found.json";

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
    expect(manifest.scopes).toContain("groups:read");
  });
});

describe("connector auth path (custody-brokered)", () => {
  test("health redeems the brokerToken and calls auth.test with the REAL token", async () => {
    const fake = fakeSlackFetch([{ method: "auth.test", body: authTestOk }]);
    const auth = fakeAuthProvider();
    const connector = createSlackConnector(auth, { fetch: fake.fetch });

    const health = await connector.health(fakeConnection());
    expect(health).toEqual({ ok: true });
    expect(auth.redemptions).toEqual([FAKE_BROKER_TOKEN]);
    // the wire only ever sees the redeemed bot token, never the broker handle
    expect(fake.calls[0]?.authorization).toBe(`Bearer ${FAKE_BOT_TOKEN}`);
  });

  test("health degrades honestly on invalid auth", async () => {
    const fake = fakeSlackFetch([{ method: "auth.test", body: authTestInvalid }]);
    const connector = createSlackConnector(fakeAuthProvider(), { fetch: fake.fetch });
    const health = await connector.health(fakeConnection());
    expect(health.ok).toBe(false);
    expect(health.error).toContain("invalid_auth");
  });

  test("sync rejects a feed the manifest does not declare", async () => {
    const connector = createSlackConnector(fakeAuthProvider(), {
      fetch: fakeSlackFetch([]).fetch,
    });
    const sink = { putBlob: () => Promise.reject(), ingestDoc: () => Promise.reject() };
    await expect(
      connector.sync(fakeConnection(), "dms", null, sink),
    ).rejects.toThrow("no feed 'dms'");
  });
});

describe("connector.act — chat.write", () => {
  const brokered = { kind: "oauth_token", token: FAKE_BROKER_TOKEN };

  test("posts a message and returns a receipt with the slack ts as externalId", async () => {
    const fake = fakeSlackFetch([{ method: "chat.postMessage", body: chatPostOk }]);
    const connector = createSlackConnector(fakeAuthProvider(), { fetch: fake.fetch });

    const receipt = await connector.act(
      fakeConnection(),
      {
        key: "chat.write",
        params: { channel: "C0100ALPHA1", text: "Evidence card: HR-42 awaiting approval" },
        intentId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
      },
      brokered,
    );

    expect(receipt.ok).toBe(true);
    expect(receipt.externalId).toBe("C0100ALPHA1:1718300000.000900");
    expect(receipt.detail).toContain("01HZZZZZZZZZZZZZZZZZZZZZZZ");
    const call = fake.callsTo("chat.postMessage")[0]!;
    expect(call.httpMethod).toBe("POST");
    expect(call.params.channel).toBe("C0100ALPHA1");
    expect(call.authorization).toBe(`Bearer ${FAKE_BOT_TOKEN}`);
  });

  test("a slack-side rejection returns an honest ok:false receipt", async () => {
    const fake = fakeSlackFetch([{ method: "chat.postMessage", body: chatPostChannelNotFound }]);
    const connector = createSlackConnector(fakeAuthProvider(), { fetch: fake.fetch });
    const receipt = await connector.act(
      fakeConnection(),
      { key: "chat.write", params: { channel: "CNOPE", text: "hi" }, intentId: "01HZZZZZZZZZZZZZZZZZZZZZZY" },
      brokered,
    );
    expect(receipt.ok).toBe(false);
    expect(receipt.detail).toContain("channel_not_found");
  });

  test("unknown action keys and invalid params throw before any network call", async () => {
    const fake = fakeSlackFetch([]);
    const connector = createSlackConnector(fakeAuthProvider(), { fetch: fake.fetch });
    await expect(
      connector.act(
        fakeConnection(),
        { key: "chat.delete", params: {}, intentId: "01HZZZZZZZZZZZZZZZZZZZZZZX" },
        brokered,
      ),
    ).rejects.toThrow("no action 'chat.delete'");
    await expect(
      connector.act(
        fakeConnection(),
        { key: "chat.write", params: { channel: "C1" }, intentId: "01HZZZZZZZZZZZZZZZZZZZZZZW" },
        brokered,
      ),
    ).rejects.toThrow(ZodError);
    expect(fake.calls).toHaveLength(0);
  });

  test("a missing brokered token fails loudly", async () => {
    const connector = createSlackConnector(fakeAuthProvider(), { fetch: fakeSlackFetch([]).fetch });
    await expect(
      connector.act(
        fakeConnection(),
        { key: "chat.write", params: { channel: "C1", text: "x" }, intentId: "01HZZZZZZZZZZZZZZZZZZZZZZV" },
        { kind: "oauth_token" },
      ),
    ).rejects.toThrow("no brokered token");
  });
});
