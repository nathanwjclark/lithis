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
  /** Agent execution (agents module / distill in context). */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /** Slack delivery + inbound Socket Mode (delivery module + slack connector). */
  SLACK_BOT_TOKEN: z.string().min(1).optional(),
  SLACK_APP_TOKEN: z.string().min(1).optional(),
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
  anthropicApiKey?: string;
  slackBotToken?: string;
  slackAppToken?: string;
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
    ...(parsed.ANTHROPIC_API_KEY !== undefined ? { anthropicApiKey: parsed.ANTHROPIC_API_KEY } : {}),
    ...(parsed.SLACK_BOT_TOKEN !== undefined ? { slackBotToken: parsed.SLACK_BOT_TOKEN } : {}),
    ...(parsed.SLACK_APP_TOKEN !== undefined ? { slackAppToken: parsed.SLACK_APP_TOKEN } : {}),
    ...(parsed.GOOGLE_CLIENT_ID !== undefined ? { googleClientId: parsed.GOOGLE_CLIENT_ID } : {}),
    ...(parsed.GOOGLE_CLIENT_SECRET !== undefined
      ? { googleClientSecret: parsed.GOOGLE_CLIENT_SECRET }
      : {}),
    ...(parsed.MS_CLIENT_ID !== undefined ? { msClientId: parsed.MS_CLIENT_ID } : {}),
    ...(parsed.MS_CLIENT_SECRET !== undefined ? { msClientSecret: parsed.MS_CLIENT_SECRET } : {}),
    ...(parsed.MS_TENANT_ID !== undefined ? { msTenantId: parsed.MS_TENANT_ID } : {}),
  };
}
