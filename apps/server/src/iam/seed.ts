import { applyMigrations, collectMigrations, createDb } from "../db";
import { loadConfig } from "../config";
import { createEventSpine } from "../spine";
import type { Db } from "../db";
import { createPgIdentityService } from "./service";
import type { IdentityService } from "./index";

/**
 * Idempotent dev seed: one tenant (slug `dev`) with one human principal
 * (slug `dev-admin`), printed as ready-to-paste identity headers for the
 * dev-header auth in the api module. Looks up by slug before creating, so
 * running it twice creates nothing.
 */

export interface DevSeed {
  tenantId: string;
  principalId: string;
  created: boolean;
}

/**
 * Lookup-only twin of ensureDevSeed: the dev tenant + dev-admin principal
 * when both exist, undefined otherwise. Boot-time consumers (the P10 dev
 * skill activation) use this so a production database — which has no `dev`
 * tenant — is never seeded as a side effect of booting.
 */
export async function findDevSeed(db: Db): Promise<DevSeed | undefined> {
  const tenantRows: { id: string }[] = await db.sql`
    select id from iam.tenants where slug = 'dev'`;
  const tenantId = tenantRows[0]?.id;
  if (tenantId === undefined) return undefined;
  const principalRows: { id: string }[] = await db.sql`
    select id from iam.principals where tenant_id = ${tenantId} and slug = 'dev-admin'`;
  const principalId = principalRows[0]?.id;
  if (principalId === undefined) return undefined;
  return { tenantId, principalId, created: false };
}

export async function ensureDevSeed(identity: IdentityService, db: Db): Promise<DevSeed> {
  const tenantRows: { id: string }[] = await db.sql`
    select id from iam.tenants where slug = 'dev'`;
  let tenantId = tenantRows[0]?.id;
  let created = false;
  if (tenantId === undefined) {
    const tenant = await identity.createTenant({ slug: "dev", name: "Dev tenant", status: "active" });
    tenantId = tenant.id;
    created = true;
  }

  const principalRows: { id: string }[] = await db.sql`
    select id from iam.principals where tenant_id = ${tenantId} and slug = 'dev-admin'`;
  let principalId = principalRows[0]?.id;
  if (principalId === undefined) {
    const principal = await identity.createPrincipal({
      tenantId,
      kind: "human",
      slug: "dev-admin",
      displayName: "Dev Admin",
      status: "active",
    });
    principalId = principal.id;
    created = true;
  }

  return { tenantId, principalId, created };
}

if (import.meta.main) {
  const config = loadConfig();
  if (config.databaseUrl === undefined) {
    console.error("DATABASE_URL is not set — nothing to seed against");
    process.exit(1);
  }
  await applyMigrations(config.databaseUrl, collectMigrations());
  const db = createDb(config.databaseUrl);
  const spine = createEventSpine(db);
  const identity = createPgIdentityService(db, spine);
  const seed = await ensureDevSeed(identity, db);
  console.log(seed.created ? "dev seed created:" : "dev seed already present:");
  console.log(`  x-lithis-tenant: ${seed.tenantId}`);
  console.log(`  x-lithis-principal: ${seed.principalId}`);
  await db.close();
}
