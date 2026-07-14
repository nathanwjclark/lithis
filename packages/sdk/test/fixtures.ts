/**
 * SDK test fixtures — the one place mock data belongs. Fully-valid records
 * used by the authoring-kit round-trip tests.
 */

import type { Connection, Origin } from "@lithis/core";
import { newUlid, nowIso } from "@lithis/core";
import type { ConnectorManifest } from "../src/connectors";

export const tenantId = newUlid();
export const connectionId = newUlid();

export function connectorOrigin(): Origin {
  return {
    by: { kind: "connection", id: connectionId },
    method: "external",
    trust: "partner",
    at: nowIso(),
  };
}

export function validManifest(): ConnectorManifest {
  return {
    slug: "carrier-portal",
    displayName: "Carrier Portal",
    authKind: "browser_session",
    feeds: [
      {
        key: "portal:loss-runs",
        description: "Loss-run documents scraped from the carrier portal",
        docTypes: ["loss_run"],
      },
    ],
    actions: [
      {
        key: "submit_form",
        capability: "browser.carrier_portal.submit",
        description: "Submit a quote request form",
      },
    ],
    scopes: ["portal:read", "portal:submit"],
  };
}

export function validConnection(): Connection {
  const at = nowIso();
  return {
    id: connectionId,
    tenantId,
    createdAt: at,
    updatedAt: at,
    connectorSlug: "carrier-portal",
    displayName: "Acme Carrier Portal",
    credentialRef: newUlid(),
    scopes: ["portal:read"],
    status: "healthy",
    health: { lastOkAt: at },
    syncState: { cursorsByFeed: {} },
  };
}
