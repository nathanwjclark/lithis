import { z } from "zod";
import type { Blob, Connection, Doc, Ref } from "@lithis/core";
import { capabilitySchema, slugSchema } from "@lithis/core";

/**
 * Connector authoring kit — the shared shape contract every connector in
 * `extensions/connectors/` implements. The manifest is zod-validated at
 * definition time; sync/act/health hooks are supplied by the connector (real
 * or stubbed via @lithis/stubkit).
 *
 * Contract notes (plan §5):
 * - sync() is idempotent and dry-runnable; it returns the next cursor.
 * - act() receives BrokeredAuth — an opaque short-lived token from custody,
 *   NEVER raw secrets — and is policy-gated upstream.
 * - Every action carries the ActionIntent id it executes, so receipts land on
 *   the spine with full provenance.
 */

export const CONNECTOR_AUTH_KINDS = ["oauth", "api_key", "browser_session", "ssh"] as const;

export const connectorFeedSchema = z.object({
  /** Feed key, e.g. "gmail:messages" or "carrier-sftp:loss-runs". */
  key: z.string().min(1),
  description: z.string(),
  /** Doc types (SchemaPack slugs) this feed produces. */
  docTypes: z.array(z.string()),
});

export const connectorActionSpecSchema = z.object({
  /** Action key, e.g. "send_email". */
  key: z.string().min(1),
  /** Dot-namespaced capability the ToolBroker checks, e.g. "gmail.send". */
  capability: capabilitySchema,
  description: z.string(),
});

export const connectorManifestSchema = z.object({
  slug: slugSchema,
  displayName: z.string().min(1),
  authKind: z.enum(CONNECTOR_AUTH_KINDS),
  feeds: z.array(connectorFeedSchema),
  actions: z.array(connectorActionSpecSchema),
  scopes: z.array(z.string()),
});
export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;

/** An action invocation: always tied to the ActionIntent being executed. */
export interface ConnectorAction {
  key: string;
  params: unknown;
  intentId: string;
}

/** Opaque brokered credential from custody — never raw secret material. */
export interface BrokeredAuth {
  kind: string;
  token?: string;
  expiresAt?: string;
}

export interface ActionReceipt {
  ok: boolean;
  /** Upstream system's id for what was created/sent, when there is one. */
  externalId?: string;
  detail?: string;
}

/** Blob input a connector hands the sink; storage placement is server-side. */
export type NewBlobInput = Pick<Blob, "mediaType" | "origin"> & { bytes: Uint8Array };

/** Doc input typed against @lithis/core — quarantined by default at ingest. */
export type NewDocInput = Pick<
  Doc,
  "type" | "slug" | "title" | "bodyBlobId" | "frontmatter" | "origin"
>;

/**
 * What a connector's sync() writes into. Implemented by server/context; the
 * connector never touches storage or the database directly.
 */
export interface IngestSink {
  putBlob(input: NewBlobInput): Promise<Ref>;
  ingestDoc(input: NewDocInput): Promise<Ref>;
}

export interface Connector {
  manifest: ConnectorManifest;
  /** Pull one feed from `cursor`, write via the sink, return the next cursor. */
  sync(
    connection: Connection,
    feed: string,
    cursor: string | null,
    sink: IngestSink,
  ): Promise<string>;
  act(
    connection: Connection,
    action: ConnectorAction,
    auth: BrokeredAuth,
  ): Promise<ActionReceipt>;
  health(connection: Connection): Promise<{ ok: boolean; error?: string }>;
}

/** The behavior a connector author supplies alongside the manifest. */
export type ConnectorHooks = Pick<Connector, "sync" | "act" | "health">;

/**
 * The auth path connectors use (mirrors the server's ConnectorRuntime seam in
 * apps/server/src/connections): custody mints the BrokeredAuth — whose `token`
 * is an opaque brokerToken, NEVER secret material — and redeem() exchanges
 * that token for the actual header/token at call time, inside server-side
 * connector code. Connectors that need authenticated calls register with the
 * runtime as a ConnectorFactory over this provider.
 */
export interface ConnectorAuthProvider {
  getAuth(connection: Connection): Promise<BrokeredAuth>;
  redeem(brokerToken: string): Promise<string>;
}

/** Factory form a connector exports when its hooks need authenticated calls. */
export type ConnectorFactory = (auth: ConnectorAuthProvider) => Connector;

/**
 * Define a connector: validates the manifest (throws ZodError on a bad one)
 * and returns the assembled Connector. Fully implemented — this is authoring
 * machinery, not a service.
 */
export function defineConnector(manifest: ConnectorManifest, hooks: ConnectorHooks): Connector {
  const parsed = connectorManifestSchema.parse(manifest);
  return {
    manifest: parsed,
    sync: hooks.sync,
    act: hooks.act,
    health: hooks.health,
  };
}
