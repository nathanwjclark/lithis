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
});

export interface ServerConfig {
  role: ServerRole;
  port: number;
  databaseUrl?: string;
  objectStoreUrl?: string;
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
  };
}
