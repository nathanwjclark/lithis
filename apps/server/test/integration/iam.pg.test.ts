import { beforeEach, expect, test } from "bun:test";
import { newUlid, tenantSchema } from "@lithis/core";
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

  test("createCharter round-trips through getCharter, emits iam.charter.created, rejects duplicates", async () => {
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

    const promptRef = { kind: "doc", id: newUlid() } as const;
    const memoryBlobId = newUlid();
    const created = await identity.createCharter({
      principalId: principal.id,
      tenantId: tenant.id,
      role: "bd operator",
      promptRef,
      memoryBlobId,
      modelPolicy: { plan: "claude-fable-5", execute: "claude-fable-5", index: "claude-haiku-4-5" },
      budgets: { usdPerRun: 5, usdPerDay: 50 },
      wake: { heartbeat: "*/30 * * * *", onEvents: ["work.item.opened"], onMessages: true },
    });

    const charter = await identity.getCharter(principal.id);
    expect(charter).toEqual(created);
    expect(charter!.wake.onMessages).toBe(true);
    expect(charter!.budgets.usdPerDay).toBe(50);

    const events = await spine.readSince(
      { consumerId: "t", tenantId: tenant.id, afterSeq: 0n },
      { topics: ["iam.charter.created"] },
    );
    expect(events.length).toBe(1);
    expect(events[0]!.subjectRefs).toEqual([{ kind: "principal", id: principal.id }, promptRef]);
    expect(events[0]!.payload).toEqual({ memoryBlobId });

    expect(
      identity.createCharter({ ...created }),
    ).rejects.toThrow(/already has an agent charter/);
  });

  test("getPrincipal/getPrincipalBySlug point lookups and listTenants enumeration", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const identity = createIdentityService(db, spine);
    const acme = await identity.createTenant({ slug: "acme", name: "Acme", status: "active" });
    const globex = await identity.createTenant({ slug: "globex", name: "Globex", status: "active" });
    const principal = await identity.createPrincipal({
      tenantId: acme.id,
      kind: "agent",
      slug: "welfare-watcher",
      displayName: "Welfare Watcher",
      status: "active",
    });

    expect(await identity.getPrincipal(principal.id)).toEqual(principal);
    expect(await identity.getPrincipal(newUlid())).toBeNull();
    expect(await identity.getPrincipalBySlug(acme.id, "welfare-watcher")).toEqual(principal);
    // Slug lookups are tenant-scoped — the other tenant sees nothing.
    expect(await identity.getPrincipalBySlug(globex.id, "welfare-watcher")).toBeNull();

    const tenants = await identity.listTenants();
    expect(tenants.map((t) => t.slug).sort()).toEqual(["acme", "globex"]);
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
