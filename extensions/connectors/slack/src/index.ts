import { defineConnector, type Connector, type ConnectorManifest } from "@lithis/sdk";
import { stub } from "@lithis/stubkit";

/**
 * Slack connector — channel-message ingestion plus chat.write, the primary
 * delivery channel for evidence cards, digests, and human↔agent conversation
 * (inbound messages emit conversation.message on the spine). Manifest is REAL
 * data; sync/act/health are registered stubs.
 */
export const manifest: ConnectorManifest = {
  slug: "slack",
  displayName: "Slack",
  authKind: "oauth",
  feeds: [
    {
      key: "channel-messages",
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
  scopes: ["channels:read", "channels:history", "groups:history", "chat:write", "users:read"],
};

export const slackConnector: Connector = defineConnector(manifest, {
  sync: stub<Connector["sync"]>(
    "connector.slack.sync",
    "LITHIS-STUB: conversations.history channel-message sync not implemented",
  ),
  act: stub<Connector["act"]>(
    "connector.slack.act",
    "LITHIS-STUB: chat.postMessage delivery action not implemented",
  ),
  health: stub<Connector["health"]>(
    "connector.slack.health",
    "LITHIS-STUB: auth.test token health probe not implemented",
  ),
});
