import { z } from "zod";
import { recordBase, slugSchema } from "./common";
import { cronSchema, isoDateTimeSchema, ulidSchema } from "./ids";

/**
 * Connectivity — one connector registry is both the integration surface
 * (pillar 2) and the ops face (pillar 11): health, sync cursors, and
 * expected-feed SLAs. Credentials are custody-brokered; agents never see raw
 * secrets, and browser sessions are sealed profiles mounted only into
 * browserhost pods.
 */

export const CONNECTION_STATUSES = ["healthy", "degraded", "expired", "disabled"] as const;

export const connectionSchema = z.object({
  ...recordBase,
  connectorSlug: slugSchema,
  displayName: z.string().min(1),
  credentialRef: ulidSchema,
  scopes: z.array(z.string()).default([]),
  status: z.enum(CONNECTION_STATUSES),
  health: z.object({
    lastOkAt: isoDateTimeSchema.optional(),
    lastError: z.string().optional(),
  }),
  syncState: z.object({
    /** Per-feed opaque cursors (gmail historyId, sftp mtime watermark, ...). */
    cursorsByFeed: z.record(z.string()),
    /** When the sync loop last ATTEMPTED this connection (success or failure). */
    lastSyncAt: isoDateTimeSchema.optional(),
    /** The last sync attempt's failure, cleared on the next success. */
    lastError: z.string().optional(),
  }),
});
export type Connection = z.infer<typeof connectionSchema>;

export const feedExpectationSchema = z.object({
  ...recordBase,
  connectionId: ulidSchema,
  /** e.g. "carrier-sftp:loss-runs" — the thing that should arrive on a cadence. */
  key: z.string().min(1),
  expectCadence: cronSchema,
  graceMinutes: z.number().int().nonnegative(),
  lastSeenAt: isoDateTimeSchema.optional(),
  missedCount: z.number().int().nonnegative().default(0),
  onMiss: z.enum(["flag", "task", "both"]),
});
export type FeedExpectation = z.infer<typeof feedExpectationSchema>;

export const CREDENTIAL_KINDS = ["oauth_token", "api_key", "password", "browser_session"] as const;

export const credentialSchema = z.object({
  ...recordBase,
  kind: z.enum(CREDENTIAL_KINDS),
  /** Where the secret material actually lives (env-file locally, Secret Manager on GCP). NEVER the value. */
  custodyBackendRef: z.string().min(1),
  holderConnectionId: ulidSchema.optional(),
  rotatesAt: isoDateTimeSchema.optional(),
});
export type Credential = z.infer<typeof credentialSchema>;
