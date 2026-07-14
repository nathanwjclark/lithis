import { defineConnector, type Connector, type ConnectorManifest } from "@lithis/sdk";
import { stub } from "@lithis/stubkit";

/**
 * Google Workspace connector — Gmail, Calendar, and Drive over OAuth.
 * The manifest is REAL data; sync/act/health are registered stubs.
 */
export const manifest: ConnectorManifest = {
  slug: "google-workspace",
  displayName: "Google Workspace",
  authKind: "oauth",
  feeds: [
    {
      key: "gmail-messages",
      description: "Incremental Gmail message sync (users.history cursor); messages land as quarantined email docs.",
      docTypes: ["email"],
    },
    {
      key: "calendar-events",
      description: "Google Calendar events via incremental syncToken.",
      docTypes: ["calendar_event"],
    },
    {
      key: "drive-files",
      description: "Drive file metadata + exportable text content via the changes cursor.",
      docTypes: ["drive_file"],
    },
  ],
  actions: [
    {
      key: "gmail.send",
      capability: "gmail.send",
      description: "Send an email as the connected user (approval-gated upstream via ActionIntent).",
    },
    {
      key: "calendar.create",
      capability: "calendar.create",
      description: "Create an event on the connected user's calendar.",
    },
  ],
  scopes: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar.events",
  ],
};

export const googleWorkspaceConnector: Connector = defineConnector(manifest, {
  sync: stub<Connector["sync"]>(
    "connector.google-workspace.sync",
    "LITHIS-STUB: Gmail/Calendar/Drive incremental feed sync not implemented",
  ),
  act: stub<Connector["act"]>(
    "connector.google-workspace.act",
    "LITHIS-STUB: gmail.send / calendar.create actions not implemented",
  ),
  health: stub<Connector["health"]>(
    "connector.google-workspace.health",
    "LITHIS-STUB: OAuth token + scope health probe not implemented",
  ),
});
