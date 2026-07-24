import { z } from "zod";

/**
 * Server configuration — REAL zod env parsing (this is not a stub). One
 * binary, four roles: `api` serves HTTP, `orchestrator` runs the dispatcher +
 * clock, `worker` hosts resident agents, `all` runs everything (the
 * docker-compose demo path).
 */

export const SERVER_ROLES = ["api", "orchestrator", "worker", "all"] as const;
export const serverRoleSchema = z.enum(SERVER_ROLES);
export type ServerRole = z.infer<typeof serverRoleSchema>;

const envSchema = z.object({
  LITHIS_ROLE: serverRoleSchema.default("all"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4400),
  /** Postgres connection string. Optional in the skeleton — no DB is opened. */
  DATABASE_URL: z.string().min(1).optional(),
  /** Object-storage endpoint (minio locally, GCS on the reference deploy). */
  OBJECT_STORE_URL: z.string().min(1).optional(),
  // ── pre-declared for later build-out phases (all optional, unused until the
  //    owning module goes real) — declared here so parallel phase branches
  //    never have to edit this file ──────────────────────────────────────────
  /** Local custody backend: dotenv-style secrets file (custody module). */
  LITHIS_SECRETS_FILE: z.string().min(1).optional(),
  /** Agent execution (agents module / distill in context). */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /** Context embeddings (OpenAI text-embedding-3-small); unset → FTS-only search. */
  OPENAI_API_KEY: z.string().min(1).optional(),
  /** Local blob-storage root when OBJECT_STORE_URL is unset (default var/blobs). */
  LITHIS_BLOB_DIR: z.string().min(1).optional(),
  /** Bucket for the Bun.s3 blob driver when OBJECT_STORE_URL is set. */
  LITHIS_BLOB_BUCKET: z.string().min(1).optional(),
  /** Model for the ingest-time distill pass (default claude-sonnet-5). */
  LITHIS_DISTILL_MODEL: z.string().min(1).optional(),
  /** Model for resident-agent executor runs (default claude-sonnet-5). */
  LITHIS_AGENT_MODEL: z.string().min(1).optional(),
  /** Rerun cascades wider than this gate as HumanRequest{cascade_plan} (processes module, default 3). */
  LITHIS_CASCADE_AUTO_WIDTH: z.coerce.number().int().positive().optional(),
  /** Sealed browser profiles root (custody browser profile store, default ~/.lithis/profiles). */
  LITHIS_BROWSER_PROFILE_DIR: z.string().min(1).optional(),
  /** Headed Chrome executable the browserhost pod drives; default = standard install paths. */
  LITHIS_CHROME_BINARY: z.string().min(1).optional(),
  /** Slack delivery + inbound Socket Mode (delivery module + slack connector). */
  SLACK_BOT_TOKEN: z.string().min(1).optional(),
  SLACK_APP_TOKEN: z.string().min(1).optional(),
  /** Default Slack channel id evidence cards post to (delivery module). */
  SLACK_DELIVERY_CHANNEL: z.string().min(1).optional(),
  /** Google Workspace connector OAuth client. */
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  /** Microsoft 365 connector (Entra app registration). */
  MS_CLIENT_ID: z.string().min(1).optional(),
  MS_CLIENT_SECRET: z.string().min(1).optional(),
  MS_TENANT_ID: z.string().min(1).optional(),
});

export interface ServerConfig {
  role: ServerRole;
  port: number;
  databaseUrl?: string;
  objectStoreUrl?: string;
  secretsFile?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  blobDir?: string;
  blobBucket?: string;
  distillModel?: string;
  agentModel?: string;
  cascadeAutoWidth?: number;
  browserProfileDir?: string;
  chromeBinary?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  slackDeliveryChannel?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  msClientId?: string;
  msClientSecret?: string;
  msTenantId?: string;
}

/**
 * Parse config from an env-shaped record (defaults to process.env). Unknown
 * keys are ignored; invalid values throw a ZodError naming the offending var.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const parsed = envSchema.parse(env);
  return {
    role: parsed.LITHIS_ROLE,
    port: parsed.PORT,
    ...(parsed.DATABASE_URL !== undefined ? { databaseUrl: parsed.DATABASE_URL } : {}),
    ...(parsed.OBJECT_STORE_URL !== undefined ? { objectStoreUrl: parsed.OBJECT_STORE_URL } : {}),
    ...(parsed.LITHIS_SECRETS_FILE !== undefined ? { secretsFile: parsed.LITHIS_SECRETS_FILE } : {}),
    ...(parsed.ANTHROPIC_API_KEY !== undefined ? { anthropicApiKey: parsed.ANTHROPIC_API_KEY } : {}),
    ...(parsed.OPENAI_API_KEY !== undefined ? { openaiApiKey: parsed.OPENAI_API_KEY } : {}),
    ...(parsed.LITHIS_BLOB_DIR !== undefined ? { blobDir: parsed.LITHIS_BLOB_DIR } : {}),
    ...(parsed.LITHIS_BLOB_BUCKET !== undefined ? { blobBucket: parsed.LITHIS_BLOB_BUCKET } : {}),
    ...(parsed.LITHIS_DISTILL_MODEL !== undefined
      ? { distillModel: parsed.LITHIS_DISTILL_MODEL }
      : {}),
    ...(parsed.LITHIS_AGENT_MODEL !== undefined ? { agentModel: parsed.LITHIS_AGENT_MODEL } : {}),
    ...(parsed.LITHIS_CASCADE_AUTO_WIDTH !== undefined
      ? { cascadeAutoWidth: parsed.LITHIS_CASCADE_AUTO_WIDTH }
      : {}),
    ...(parsed.LITHIS_BROWSER_PROFILE_DIR !== undefined
      ? { browserProfileDir: parsed.LITHIS_BROWSER_PROFILE_DIR }
      : {}),
    ...(parsed.LITHIS_CHROME_BINARY !== undefined
      ? { chromeBinary: parsed.LITHIS_CHROME_BINARY }
      : {}),
    ...(parsed.SLACK_BOT_TOKEN !== undefined ? { slackBotToken: parsed.SLACK_BOT_TOKEN } : {}),
    ...(parsed.SLACK_APP_TOKEN !== undefined ? { slackAppToken: parsed.SLACK_APP_TOKEN } : {}),
    ...(parsed.SLACK_DELIVERY_CHANNEL !== undefined
      ? { slackDeliveryChannel: parsed.SLACK_DELIVERY_CHANNEL }
      : {}),
    ...(parsed.GOOGLE_CLIENT_ID !== undefined ? { googleClientId: parsed.GOOGLE_CLIENT_ID } : {}),
    ...(parsed.GOOGLE_CLIENT_SECRET !== undefined
      ? { googleClientSecret: parsed.GOOGLE_CLIENT_SECRET }
      : {}),
    ...(parsed.MS_CLIENT_ID !== undefined ? { msClientId: parsed.MS_CLIENT_ID } : {}),
    ...(parsed.MS_CLIENT_SECRET !== undefined ? { msClientSecret: parsed.MS_CLIENT_SECRET } : {}),
    ...(parsed.MS_TENANT_ID !== undefined ? { msTenantId: parsed.MS_TENANT_ID } : {}),
  };
}
