import { beforeEach, expect, test } from "bun:test";
import { newUlid } from "@lithis/core";
import type { Event } from "@lithis/core";
import { createEventSpine } from "../../src/spine";
import type { NewEvent } from "../../src/spine";
import { describePg, freshDb, truncateAll } from "../helpers/pg";

function tenantEvent(tenantId: string, slug = "acme"): NewEvent {
  return {
    tenantId,
    topic: "iam.tenant.created",
    subjectRefs: [{ kind: "tenant", id: tenantId }],
    actor: { kind: "tenant", id: tenantId },
    payload: { slug },
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describePg("EventSpine (integration)", () => {
  beforeEach(async () => {
    await truncateAll(await freshDb());
  });

  test("append assigns gapless per-tenant seq starting at 1", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const tenantId = newUlid();
    for (let i = 1; i <= 3; i++) {
      const e = await db.withTx((tx) => spine.append(tx, tenantEvent(tenantId)));
      expect(e.seq).toBe(BigInt(i));
    }
  });

  test("20 concurrent appends yield gapless unique seqs", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const tenantId = newUlid();
    const events = await Promise.all(
      Array.from({ length: 20 }, () => db.withTx((tx) => spine.append(tx, tenantEvent(tenantId)))),
    );
    const seqs = events.map((e) => e.seq).sort((a, b) => (a < b ? -1 : 1));
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => BigInt(i + 1)));
  });

  test("unregistered topic throws and persists nothing", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const tenantId = newUlid();
    expect(
      db.withTx((tx) =>
        spine.append(tx, { ...tenantEvent(tenantId), topic: "never.registered.topic" }),
      ),
    ).rejects.toThrow(/not registered/);
    const rows: unknown[] = await db.sql`select 1 from spine.events where tenant_id = ${tenantId}`;
    expect(rows).toEqual([]);
  });

  test("outbox contract: caller rollback removes the event", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const tenantId = newUlid();
    await expect(
      db.withTx(async (tx) => {
        await spine.append(tx, tenantEvent(tenantId));
        throw new Error("caller mutation failed after append");
      }),
    ).rejects.toThrow(/caller mutation failed/);
    const rows: unknown[] = await db.sql`select 1 from spine.events where tenant_id = ${tenantId}`;
    expect(rows).toEqual([]);
  });

  test("readSince respects tenant, afterSeq, selector, and limit", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const tenantA = newUlid();
    const tenantB = newUlid();
    for (let i = 0; i < 5; i++) {
      await db.withTx((tx) => spine.append(tx, tenantEvent(tenantA)));
    }
    await db.withTx((tx) => spine.append(tx, tenantEvent(tenantB)));

    const all = await spine.readSince({ consumerId: "r", tenantId: tenantA, afterSeq: 0n });
    expect(all.length).toBe(5);
    const after3 = await spine.readSince({ consumerId: "r", tenantId: tenantA, afterSeq: 3n });
    expect(after3.map((e) => e.seq)).toEqual([4n, 5n]);
    const limited = await spine.readSince({ consumerId: "r", tenantId: tenantA, afterSeq: 0n }, undefined, 2);
    expect(limited.map((e) => e.seq)).toEqual([1n, 2n]);
    const filtered = await spine.readSince(
      { consumerId: "r", tenantId: tenantA, afterSeq: 0n },
      { topics: ["work.*"] },
    );
    expect(filtered).toEqual([]);
  });

  test("subscribe delivers in order and checkpoints durably", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const tenantId = newUlid();
    const seen: bigint[] = [];
    spine.startDispatcher({ intervalMs: 50 });
    const sub = spine.subscribe("itest", { topics: ["iam.*"] }, async (e) => {
      seen.push(e.seq);
    });
    for (let i = 0; i < 3; i++) {
      await db.withTx((tx) => spine.append(tx, tenantEvent(tenantId)));
    }
    await waitFor(() => seen.length === 3);
    expect(seen).toEqual([1n, 2n, 3n]);
    await sub.close();
    await spine.stopDispatcher();

    // durable cursor: a NEW runtime + same consumerId does not redeliver
    const spine2 = createEventSpine(db);
    const seenAgain: Event[] = [];
    spine2.startDispatcher({ intervalMs: 50 });
    spine2.subscribe("itest", { topics: ["iam.*"] }, async (e) => {
      seenAgain.push(e);
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(seenAgain).toEqual([]);
    await spine2.stopDispatcher();
  });

  test("failing handler is redelivered (at-least-once) and blocks later events until success", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const tenantId = newUlid();
    let attempts = 0;
    const delivered: bigint[] = [];
    spine.startDispatcher({ intervalMs: 30 });
    spine.subscribe("flaky", {}, async (e) => {
      if (e.seq === 1n) {
        attempts += 1;
        if (attempts < 3) throw new Error("transient handler failure");
      }
      delivered.push(e.seq);
    });
    await db.withTx((tx) => spine.append(tx, tenantEvent(tenantId)));
    await db.withTx((tx) => spine.append(tx, tenantEvent(tenantId)));
    // seq 1 fails twice (1s then 2s backoff would be slow — cap the wait via retries)
    await waitFor(() => delivered.length === 2, 8_000);
    expect(attempts).toBe(3); // seen at least 3 times before success
    expect(delivered).toEqual([1n, 2n]); // seq 2 was blocked until seq 1 succeeded
    await spine.stopDispatcher();
  }, 10_000);

  test("cursor scan advances past non-matching events (sparse selectors don't rescan)", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const tenantId = newUlid();
    spine.startDispatcher({ intervalMs: 30 });
    spine.subscribe("sparse", { topics: ["work.*"] }, async () => {});
    await db.withTx((tx) => spine.append(tx, tenantEvent(tenantId)));
    let cursorSeq = 0n;
    const start = Date.now();
    while (cursorSeq !== 1n) {
      if (Date.now() - start > 3_000) throw new Error("cursor never advanced past non-match");
      await new Promise((r) => setTimeout(r, 25));
      const rows: { after_seq: bigint | number }[] = await db.sql`
        select after_seq from spine.consumer_cursors
        where consumer_id = 'sparse' and tenant_id = ${tenantId}`;
      if (rows.length > 0) cursorSeq = BigInt(rows[0]!.after_seq);
    }
    await spine.stopDispatcher();
  });
});
