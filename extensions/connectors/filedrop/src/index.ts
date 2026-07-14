import { defineConnector, type Connector, type ConnectorManifest } from "@lithis/sdk";
import { stub } from "@lithis/stubkit";

/**
 * Filedrop connector — watched SFTP/S3 paths where counterparties drop files
 * (carrier loss runs, commission statements, regulator uploads). Ingest-only:
 * no actions. Watched paths with a promised cadence should be paired with a
 * FeedExpectation (see README) so a missed drop becomes a flag/WorkItem.
 * Manifest is REAL data; sync/health are registered stubs.
 */
export const manifest: ConnectorManifest = {
  slug: "filedrop",
  displayName: "Filedrop (SFTP/S3)",
  authKind: "ssh",
  feeds: [
    {
      key: "watched-path",
      description:
        "New/modified files under a configured remote path (mtime/etag watermark cursor); each file lands as a Blob + quarantined file_drop doc. One feed per watched path, keyed at connection config time.",
      docTypes: ["file_drop"],
    },
  ],
  // Ingest-only by design: lithis never writes into a counterparty's drop zone.
  actions: [],
  scopes: [],
};

export const filedropConnector: Connector = defineConnector(manifest, {
  sync: stub<Connector["sync"]>(
    "connector.filedrop.sync",
    "LITHIS-STUB: SFTP/S3 watched-path watermark sync not implemented",
  ),
  act: stub<Connector["act"]>(
    "connector.filedrop.act",
    "LITHIS-STUB: filedrop declares no actions; act() is unreachable by design and unimplemented",
  ),
  health: stub<Connector["health"]>(
    "connector.filedrop.health",
    "LITHIS-STUB: remote path reachability/permissions probe not implemented",
  ),
});
