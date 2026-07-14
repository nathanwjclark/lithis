import { describe, expect, test } from "bun:test";
import { createSlackClient, listAllChannels } from "../src/client";

/**
 * Live smoke against the real Slack Web API — runs ONLY when SLACK_BOT_TOKEN
 * is set (a bot token with at least channels:read + users:read; the full
 * connector wants channels:history, groups:read, groups:history, chat:write
 * too). Without the env var these tests SKIP — they never fake a pass.
 */
const token = process.env.SLACK_BOT_TOKEN;

describe("slack live smoke (SLACK_BOT_TOKEN)", () => {
  test.skipIf(token === undefined || token === "")(
    "auth.test authenticates and conversations.list pages",
    async () => {
      const client = createSlackClient({ token: token! });
      const identity = await client.authTest();
      expect(identity.team_id).toBeDefined();
      expect(identity.user_id).toBeDefined();

      const channels = await listAllChannels(client, { types: "public_channel", limit: 5 });
      expect(Array.isArray(channels)).toBe(true);
    },
  );
});
