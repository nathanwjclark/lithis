import { defineConnector, type Connector, type ConnectorManifest } from "@lithis/sdk";
import { stub } from "@lithis/stubkit";

/**
 * Microsoft 365 connector — Outlook mail/calendar and OneDrive over Microsoft
 * Graph (OAuth delegated permissions). Manifest is REAL data; sync/act/health
 * are registered stubs.
 */
export const manifest: ConnectorManifest = {
  slug: "microsoft-365",
  displayName: "Microsoft 365",
  authKind: "oauth",
  feeds: [
    {
      key: "mail-messages",
      description: "Outlook mail via Graph delta queries; messages land as quarantined email docs.",
      docTypes: ["email"],
    },
    {
      key: "calendar-events",
      description: "Outlook calendar events via Graph calendarView delta.",
      docTypes: ["calendar_event"],
    },
    {
      key: "onedrive-files",
      description: "OneDrive/SharePoint file metadata + extractable content via drive delta.",
      docTypes: ["drive_file"],
    },
  ],
  actions: [
    {
      key: "mail.send",
      capability: "m365.mail.send",
      description: "Send an email as the connected user via Graph sendMail (approval-gated upstream).",
    },
    {
      key: "calendar.create",
      capability: "m365.calendar.create",
      description: "Create an event on the connected user's Outlook calendar.",
    },
  ],
  scopes: [
    "https://graph.microsoft.com/Mail.Read",
    "https://graph.microsoft.com/Mail.Send",
    "https://graph.microsoft.com/Calendars.ReadWrite",
    "https://graph.microsoft.com/Files.Read.All",
    "offline_access",
  ],
};

export const microsoft365Connector: Connector = defineConnector(manifest, {
  sync: stub<Connector["sync"]>(
    "connector.microsoft-365.sync",
    "LITHIS-STUB: Graph delta-query feed sync (mail/calendar/onedrive) not implemented",
  ),
  act: stub<Connector["act"]>(
    "connector.microsoft-365.act",
    "LITHIS-STUB: Graph sendMail / event-create actions not implemented",
  ),
  health: stub<Connector["health"]>(
    "connector.microsoft-365.health",
    "LITHIS-STUB: Graph token + consent health probe not implemented",
  ),
});
