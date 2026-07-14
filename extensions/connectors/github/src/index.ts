import { defineConnector, type Connector, type ConnectorManifest } from "@lithis/sdk";
import { stub } from "@lithis/stubkit";

/**
 * GitHub connector — repository/issue/PR ingestion (feeds the portal infra map
 * and the workbench PR flow) plus issue creation. Token (PAT / GitHub App
 * installation token) auth. Manifest is REAL data; sync/act/health are
 * registered stubs.
 */
export const manifest: ConnectorManifest = {
  slug: "github",
  displayName: "GitHub",
  authKind: "api_key",
  feeds: [
    {
      key: "repos",
      description: "Repository metadata for the installation/user (pagination cursor on pushed_at).",
      docTypes: ["repository"],
    },
    {
      key: "issues",
      description: "Issues across synced repos (since-timestamp cursor).",
      docTypes: ["issue"],
    },
    {
      key: "prs",
      description: "Pull requests across synced repos, incl. workbench-originated PRs (updated_at cursor).",
      docTypes: ["pull_request"],
    },
  ],
  actions: [
    {
      key: "issue.create",
      capability: "github.issue.create",
      description: "Open an issue on a synced repository (approval-gated upstream via ActionIntent).",
    },
  ],
  scopes: ["repo", "read:org"],
};

export const githubConnector: Connector = defineConnector(manifest, {
  sync: stub<Connector["sync"]>(
    "connector.github.sync",
    "LITHIS-STUB: repos/issues/prs REST feed sync not implemented",
  ),
  act: stub<Connector["act"]>(
    "connector.github.act",
    "LITHIS-STUB: issue.create action not implemented",
  ),
  health: stub<Connector["health"]>(
    "connector.github.health",
    "LITHIS-STUB: token scope/rate-limit health probe not implemented",
  ),
});
