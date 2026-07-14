import type { Connection } from "@lithis/core";
import { defineConnector } from "@lithis/sdk";
import type {
  BrokeredAuth,
  Connector,
  ConnectorAuthProvider,
  ConnectorManifest,
} from "@lithis/sdk";
import { performChatWrite } from "./act";
import { createSlackClient } from "./client";
import type { SlackClient, SlackTransportOptions } from "./client";
import { CHANNEL_MESSAGES_FEED_KEY, syncChannelMessages } from "./sync";

/**
 * Slack connector — channel-message ingestion plus chat.write, the primary
 * delivery channel for evidence cards, digests, and human↔agent conversation.
 * Fully implemented over a fetch-based Web API client (no @slack/web-api):
 * cursor-driven conversations.history sync, 429 Retry-After handling, and
 * custody-brokered auth — the connector only ever sees a brokerToken and
 * redeems it through the ConnectorAuthProvider at call time.
 */
export const manifest: ConnectorManifest = {
  slug: "slack",
  displayName: "Slack",
  authKind: "oauth",
  feeds: [
    {
      key: CHANNEL_MESSAGES_FEED_KEY,
      description:
        "Messages from channels the app is a member of (conversations.history cursor); land as quarantined message docs and emit conversation.message.",
      docTypes: ["message"],
    },
  ],
  actions: [
    {
      key: "chat.write",
      capability: "slack.chat.write",
      description: "Post a message (evidence card, digest, nudge, or reply) to a channel or thread.",
    },
  ],
  scopes: ["channels:read", "channels:history", "groups:read", "groups:history", "chat:write", "users:read"],
};

export type { SlackTransportOptions } from "./client";
export {
  createSlackClient,
  listAllChannels,
  SLACK_API_BASE_URL,
  SlackApiError,
  SlackHttpError,
  SlackRateLimitError,
} from "./client";
export { CHANNEL_MESSAGES_FEED_KEY, syncChannelMessages } from "./sync";
export { chatWriteParamsSchema } from "./act";
export {
  decodeCursor,
  encodeCursor,
  messageSlug,
  normalizeMessage,
  shouldIngestMessage,
} from "./normalize";

/**
 * Build the Slack connector over the ConnectorRuntime auth seam. The
 * signature matches ConnectorFactory, so wiring is just
 * `runtime.register(createSlackConnector)`; transport knobs (injected fetch,
 * sleep, base URL) exist for tests and stay defaulted in production.
 */
export function createSlackConnector(
  auth: ConnectorAuthProvider,
  transport: SlackTransportOptions = {},
): Connector {
  async function clientFor(connection: Connection): Promise<SlackClient> {
    const brokered = await auth.getAuth(connection);
    return clientFromBrokered(brokered, connection);
  }

  async function clientFromBrokered(
    brokered: BrokeredAuth,
    connection: Connection,
  ): Promise<SlackClient> {
    if (brokered.token === undefined || brokered.token === "") {
      throw new Error(
        `no brokered token for slack connection ${connection.id} — check its credential in custody`,
      );
    }
    const token = await auth.redeem(brokered.token);
    return createSlackClient({ ...transport, token });
  }

  return defineConnector(manifest, {
    async sync(connection, feed, cursor, sink) {
      if (feed !== CHANNEL_MESSAGES_FEED_KEY) {
        throw new Error(`slack connector has no feed '${feed}'`);
      }
      const client = await clientFor(connection);
      return syncChannelMessages(client, connection, cursor, sink);
    },
    async act(connection, action, brokered) {
      const client = await clientFromBrokered(brokered, connection);
      return performChatWrite(client, action);
    },
    async health(connection) {
      try {
        const client = await clientFor(connection);
        await client.authTest();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}
