import { defineConnector, type Connector, type ConnectorManifest } from "@lithis/sdk";
import { stub } from "@lithis/stubkit";

/**
 * LinkedIn connector — browser_session auth: a sealed custody Chrome profile
 * mounted into a browserhost pod, driven over brokered CDP with timing-only
 * humanization (CAPTCHA = pause + notify, never auto-solve).
 *
 * DEGREE GUARD: everything ingested here is degree 2 (prospects) and never
 * surfaces in network-audience queries — see README. Outreach actions run only
 * against approved ActionIntent batches.
 *
 * Manifest is REAL data; sync/act/health are registered stubs.
 */
export const manifest: ConnectorManifest = {
  slug: "linkedin",
  displayName: "LinkedIn (browser)",
  authKind: "browser_session",
  feeds: [
    {
      key: "salesnav-search",
      description:
        "Sales Navigator search-result pages for configured queries; cards become degree-2 person entities with mutual-connection hints.",
      docTypes: ["salesnav_search_page"],
    },
    {
      key: "profile",
      description:
        "Individual prospect profile pages (page capture + extracted fields); always ingested at degree 2.",
      docTypes: ["linkedin_profile"],
    },
  ],
  actions: [
    {
      key: "connect",
      capability: "browser.linkedin.connect",
      description: "Send a connection request (optional note); only from an approved ActionIntent batch.",
    },
    {
      key: "message",
      capability: "browser.linkedin.message",
      description: "Send a message/InMail; only from an approved ActionIntent batch.",
    },
  ],
  // browser_session auth has no OAuth scopes; the sealed profile IS the grant.
  scopes: [],
};

export const linkedinConnector: Connector = defineConnector(manifest, {
  sync: stub<Connector["sync"]>(
    "connector.linkedin.sync",
    "LITHIS-STUB: browserhost-driven salesnav/profile page capture + degree-2 ingestion not implemented",
  ),
  act: stub<Connector["act"]>(
    "connector.linkedin.act",
    "LITHIS-STUB: humanized connect/message actions (ActionIntent-gated) not implemented",
  ),
  health: stub<Connector["health"]>(
    "connector.linkedin.health",
    "LITHIS-STUB: sealed-session validity probe (logged-in check via browserhost) not implemented",
  ),
});
