import { beforeEach, expect, test } from "bun:test";
import { newUlid, nowIso, tenantSchema } from "@lithis/core";
import { createIdentityService, ensureDevSeed } from "../../src/iam";
import { createEventSpine } from "../../src/spine";
import { describePg, freshDb, truncateAll } from "../helpers/pg";

describePg("IdentityService (integration)", () => {
  beforeEach(async () => {
    await truncateAll(await freshDb());
  });

  test("createTenant round-trips and emits iam.tenant.created with seq 1", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const identity = createIdentityService(db, spine);

    const tenant = await identity.createTenant({ slug: "acme", name: "Acme Logistics", status: "active" });
    expect(tenantSchema.parse(tenant)).toEqual(tenant);

    const rows: { slug: string }[] = await db.sql`select slug from iam.tenants where id = ${tenant.id}`;
    expect(rows[0]?.slug).toBe("acme");

    const events = await spine.readSince({ consumerId: "t", tenantId: tenant.id, afterSeq: 0n });
    expect(events.length).toBe(1);
    expect(events[0]!.topic).toBe("iam.tenant.created");
    expect(events[0]!.seq).toBe(1n);
    expect(events[0]!.payload).toEqual({ slug: "acme" });
  });

  test("createPrincipal round-trips, emits, and rejects duplicate slugs clearly", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const identity = createIdentityService(db, spine);
    const tenant = await identity.createTenant({ slug: "acme", name: "Acme", status: "active" });

    const principal = await identity.createPrincipal({
      tenantId: tenant.id,
      kind: "agent",
      slug: "bd-agent",
      displayName: "BD Agent",
      status: "active",
    });
    expect(principal.kind).toBe("agent");

    const events = await spine.readSince(
      { consumerId: "t", tenantId: tenant.id, afterSeq: 0n },
      { topics: ["iam.principal.*"] },
    );
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toEqual({ kind: "agent", slug: "bd-agent" });

    expect(
      identity.createPrincipal({
        tenantId: tenant.id,
        kind: "human",
        slug: "bd-agent",
        displayName: "Duplicate",
        status: "active",
      }),
    ).rejects.toThrow(/already exists in tenant/);
  });

  test("getCharter returns null for plain principals, parsed charter for residents", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const identity = createIdentityService(db, spine);
    const tenant = await identity.createTenant({ slug: "acme", name: "Acme", status: "active" });
    const principal = await identity.createPrincipal({
      tenantId: tenant.id,
      kind: "agent",
      slug: "resident",
      displayName: "Resident Agent",
      status: "active",
    });

    expect(await identity.getCharter(principal.id)).toBeNull();

    // Charter authoring is a later-phase surface; integration fixture inserts the row directly.
    const at = nowIso();
    await db.sql`
      insert into iam.agent_charters
        (principal_id, tenant_id, role, prompt_ref, memory_blob_id, model_policy, budgets, wake, created_at, updated_at)
      values
        (${principal.id}, ${tenant.id}, 'bd operator',
         ${JSON.stringify({ kind: "doc", id: newUlid() })}::jsonb,
         ${newUlid()},
         ${JSON.stringify({ plan: "claude-fable-5", execute: "claude-fable-5", index: "claude-haiku-4-5-20251001" })}::jsonb,
         ${JSON.stringify({ usdPerRun: 5, usdPerDay: 50 })}::jsonb,
         ${JSON.stringify({ heartbeat: "*/30 * * * *", onEvents: ["work.item.opened"], onMessages: true })}::jsonb,
         ${at}, ${at})`;

    const charter = await identity.getCharter(principal.id);
    expect(charter).not.toBeNull();
    expect(charter!.wake.onMessages).toBe(true);
    expect(charter!.budgets.usdPerDay).toBe(50);
  });

  test("ensureDevSeed is idempotent", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const identity = createIdentityService(db, spine);

    const first = await ensureDevSeed(identity, db);
    expect(first.created).toBe(true);
    const second = await ensureDevSeed(identity, db);
    expect(second.created).toBe(false);
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.principalId).toBe(first.principalId);

    const tenants: unknown[] = await db.sql`select 1 from iam.tenants where slug = 'dev'`;
    expect(tenants.length).toBe(1);
  });
});
