import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUlid, nowIso } from "@lithis/core";
import type { Origin } from "@lithis/core";
import { createContextStore, createLocalBlobStorage } from "../../src/context";
import type { ContextStore, DocRef } from "../../src/context";
import type { DistillLlm, EmbeddingProvider } from "../../src/context";
import { EMBEDDING_DIM } from "../../src/context/embeddings";
import { createEventSpine } from "../../src/spine";
import type { EventSpine } from "../../src/spine";
import { describePg, freshDb, truncateAll } from "../helpers/pg";

/**
 * Integration coverage for the P4 context store: blob dedup, quarantined
 * ingest + the deterministic index, hybrid search (FTS, vector via an
 * injected deterministic embedding fixture — never a live API), the audience
 * choke point, the distill pass against a fixture LLM, and basic paths.
 */

const blobDir = mkdtempSync(join(tmpdir(), "lithis-ctx-it-"));

/** Deterministic embedding fixture: topic keyword → basis vector. */
function basis(i: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[i] = 1;
  return v;
}
const fixtureEmbeddings: EmbeddingProvider = {
  dim: EMBEDDING_DIM,
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const lower = t.toLowerCase();
      if (lower.includes("zebra") || lower.includes("wildlife")) return basis(0);
      if (lower.includes("renewal")) return basis(1);
      return basis(7);
    });
  },
};

const fixtureDistillAnswer = JSON.stringify({
  summary: "Jane Doe of Acme Corp asked for the Q3 loss runs before her renewal.",
  entities: [
    { type: "person", slug: "jane-doe", name: "Jane Doe", degree: 2 },
    { type: "company", slug: "acme-corp", name: "Acme Corp", degree: 2 },
  ],
  links: [{ from: "person:jane-doe", to: "company:acme-corp", verb: "works_at", weight: 0.9 }],
});
const fixtureDistillLlm: DistillLlm = async () => fixtureDistillAnswer;

interface Harness {
  store: ContextStore;
  spine: EventSpine;
  tenantId: string;
  principalId: string;
  origin: Origin;
  ctx: { tenantId: string; principalId: string; kind: "human" };
}

async function harness(overrides?: { embeddings?: false }): Promise<Harness> {
  const db = await freshDb();
  const spine = createEventSpine(db);
  const tenantId = newUlid();
  const principalId = newUlid();
  const origin: Origin = {
    by: { kind: "principal", id: principalId },
    method: "external",
    trust: "untrusted",
    at: nowIso(),
  };
  const store = createContextStore(db, spine, {
    blobs: createLocalBlobStorage(blobDir),
    ...(overrides?.embeddings === false ? {} : { embeddings: fixtureEmbeddings }),
    distillLlm: fixtureDistillLlm,
  });
  return { store, spine, tenantId, principalId, origin, ctx: { tenantId, principalId, kind: "human" } };
}

async function ingestText(h: Harness, slug: string, title: string, text: string): Promise<DocRef> {
  const blob = await h.store.putBlob(
    { tenantId: h.tenantId, mediaType: "text/plain", origin: h.origin },
    new TextEncoder().encode(text),
  );
  return await h.store.ingestDoc({
    tenantId: h.tenantId,
    type: "email",
    slug,
    title,
    bodyBlobId: blob.id,
    frontmatter: {},
    origin: h.origin,
  });
}

const EMAILS: [slug: string, title: string, body: string][] = [
  [
    "email-loss-runs",
    "Q3 loss runs for the trucking fleet",
    "Hi team,\n\nAttached are the quarterly loss runs for the trucking fleet. Two claims exceeded the deductible this period; the loss ratio is trending up.\n\nThanks,\nJane",
  ],
  [
    "email-renewal",
    "Property renewal quote",
    "Hello,\n\nHere is the renewal quote for the property coverage. Premium is up 8% year over year; happy to walk through the terms.\n\nBest,\nMark",
  ],
  [
    "email-offsite",
    "Team offsite planning",
    "Hey all,\n\nA zebra sanctuary was suggested as the venue for the offsite. Please vote on dates by Friday.\n\nCheers,\nPat",
  ],
];

describePg("ContextStore (integration)", () => {
  beforeEach(async () => {
    await truncateAll(await freshDb());
  });

  test("putBlob dedups on (tenant, sha256): same bytes → same ref, one row, one event", async () => {
    const h = await harness();
    const db = await freshDb();
    const bytes = new TextEncoder().encode("identical bytes");
    const first = await h.store.putBlob(
      { tenantId: h.tenantId, mediaType: "text/plain", origin: h.origin },
      bytes,
    );
    const second = await h.store.putBlob(
      { tenantId: h.tenantId, mediaType: "text/plain", origin: h.origin },
      bytes,
    );
    expect(second).toEqual(first);

    const rows: unknown[] = await db.sql`
      select 1 from context.blobs where tenant_id = ${h.tenantId}`;
    expect(rows.length).toBe(1);

    const events = await h.spine.readSince(
      { consumerId: "t", tenantId: h.tenantId, afterSeq: 0n },
      { topics: ["context.blob.created"] },
    );
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toEqual({
      mediaType: "text/plain",
      sizeBytes: bytes.byteLength,
      trust: "untrusted",
    });
  });

  test("ingestDoc quarantines by default, chunks the body, and emits context.doc.created", async () => {
    const h = await harness();
    const db = await freshDb();
    const doc = await ingestText(h, ...EMAILS[0]!);

    const docRows: { quarantined: boolean }[] = await db.sql`
      select quarantined from context.docs where id = ${doc.id}`;
    expect(docRows[0]!.quarantined).toBe(true);

    const chunkRows: { ord: number; text: string; embedding: unknown }[] = await db.sql`
      select ord, text, embedding from context.chunks where doc_id = ${doc.id} order by ord`;
    expect(chunkRows.length).toBeGreaterThan(0);
    expect(chunkRows[0]!.text).toContain("loss runs");
    expect(chunkRows[0]!.embedding).not.toBeNull();

    const events = await h.spine.readSince(
      { consumerId: "t", tenantId: h.tenantId, afterSeq: 0n },
      { topics: ["context.doc.created"] },
    );
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toEqual({ docType: "email" });
    expect(events[0]!.subjectRefs).toEqual([{ kind: "doc", id: doc.id }]);
  });

  test("ACCEPTANCE: ingest fixture emails → FTS search finds them, ranked, with excerpts", async () => {
    const h = await harness();
    const refs = await Promise.all(EMAILS.map((e) => ingestText(h, ...e)));

    const hits = await h.store.search({ text: "loss runs" }, h.ctx);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.ref).toEqual({ kind: "doc", id: refs[0]!.id });
    expect(hits[0]!.excerpt).toMatch(/loss/i);
    expect(hits[0]!.score).toBeGreaterThan(0);
    // sensible ranking: the offsite email (not about loss runs) never outranks
    // the loss-runs email. (RRF applies no similarity cutoff, so the vector
    // arm may still surface it at the bottom of the pool.)
    const ids = hits.map((s) => s.ref.id);
    if (ids.includes(refs[2]!.id)) {
      expect(ids.indexOf(refs[2]!.id)).toBeGreaterThan(ids.indexOf(refs[0]!.id));
    }

    const renewal = await h.store.search({ text: "renewal premium" }, h.ctx);
    expect(renewal[0]!.ref.id).toBe(refs[1]!.id);

    // docTypes + limit are honored
    const none = await h.store.search({ text: "loss runs", docTypes: ["meeting"] }, h.ctx);
    expect(none).toEqual([]);
    const limited = await h.store.search({ text: "the" , limit: 1 }, h.ctx);
    expect(limited.length).toBeLessThanOrEqual(1);
  });

  test("vector arm: semantic query with zero FTS overlap still finds the doc", async () => {
    const h = await harness();
    const refs = await Promise.all(EMAILS.map((e) => ingestText(h, ...e)));
    // 'wildlife' appears in NO document, but the fixture embedding maps it to
    // the same basis vector as 'zebra' (the offsite email).
    const hits = await h.store.search({ text: "wildlife" }, h.ctx);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.ref.id).toBe(refs[2]!.id);
  });

  test("FTS-only degrade: without an embedding provider search still works", async () => {
    const h = await harness({ embeddings: false });
    const db = await freshDb();
    const refs = await Promise.all(EMAILS.map((e) => ingestText(h, ...e)));

    const chunkRows: { embedding: unknown }[] = await db.sql`
      select embedding from context.chunks where doc_id = ${refs[0]!.id}`;
    expect(chunkRows.every((r) => r.embedding === null)).toBe(true);

    const hits = await h.store.search({ text: "loss runs" }, h.ctx);
    expect(hits[0]!.ref.id).toBe(refs[0]!.id);

    // and the purely-semantic query finds nothing (no vector arm to carry it)
    const semantic = await h.store.search({ text: "wildlife" }, h.ctx);
    expect(semantic).toEqual([]);
  });

  test("distill: writes summary once, upserts entities, links + events; re-distill throws", async () => {
    const h = await harness();
    const db = await freshDb();
    const doc = await ingestText(h, ...EMAILS[0]!);

    const result = await h.store.distill(doc);
    expect(result.docId).toBe(doc.id);
    expect(result.summary).toContain("Jane Doe");
    expect(result.entities.length).toBe(2);
    // model links + deterministic doc→entity mentions links
    const verbs = result.links.map((l) => l.verb).sort();
    expect(verbs).toEqual(["mentions", "mentions", "works_at"]);
    const jane = result.entities.find((e) => e.slug === "jane-doe")!;
    expect(jane.degree).toBe(2);
    expect(jane.origin.method).toBe("llm");
    expect(jane.origin.trust).toBe("untrusted"); // inherited from the quarantined doc

    const docRows: { summary: string | null; revision: number }[] = await db.sql`
      select summary, revision from context.docs where id = ${doc.id}`;
    expect(docRows[0]!.summary).toContain("Jane Doe");
    expect(docRows[0]!.revision).toBe(1);

    const events = await h.spine.readSince(
      { consumerId: "t", tenantId: h.tenantId, afterSeq: 0n },
      { topics: ["context.doc.distilled", "context.entity.created", "context.link.created"] },
    );
    const byTopic = new Map<string, number>();
    for (const e of events) byTopic.set(e.topic, (byTopic.get(e.topic) ?? 0) + 1);
    expect(byTopic.get("context.entity.created")).toBe(2);
    expect(byTopic.get("context.link.created")).toBe(3);
    expect(byTopic.get("context.doc.distilled")).toBe(1);
    const distilled = events.find((e) => e.topic === "context.doc.distilled")!;
    expect((distilled.payload as { entityIds: string[] }).entityIds.sort()).toEqual(
      result.entities.map((e) => e.id).sort(),
    );

    expect(h.store.distill(doc)).rejects.toThrow(/already distilled/);

    // second doc mentioning the same company: entity is upserted, not duplicated
    const doc2 = await ingestText(h, ...EMAILS[1]!);
    const result2 = await h.store.distill(doc2);
    const acme2 = result2.entities.find((e) => e.slug === "acme-corp")!;
    const acme1 = result.entities.find((e) => e.slug === "acme-corp")!;
    expect(acme2.id).toBe(acme1.id);
    const entityRows: unknown[] = await db.sql`
      select 1 from context.entities where tenant_id = ${h.tenantId} and slug = 'acme-corp'`;
    expect(entityRows.length).toBe(1);
  });

  test("distill without ANTHROPIC_API_KEY is an honest config error", async () => {
    const h = await harness();
    const db = await freshDb();
    const spine = createEventSpine(db);
    const bare = createContextStore(db, spine, { blobs: createLocalBlobStorage(blobDir) });
    const doc = await ingestText(h, ...EMAILS[0]!);
    expect(bare.distill(doc)).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  test("audience choke point: prospect-linked docs and degree-2 entities are fenced", async () => {
    const h = await harness();
    const refs = await Promise.all(EMAILS.map((e) => ingestText(h, ...e)));
    // distilling the loss-runs email links it to degree-2 (prospect) entities
    await h.store.distill(refs[0]!);

    // default audience 'network' now EXCLUDES the prospect-linked doc
    const network = await h.store.search({ text: "loss runs" }, h.ctx);
    expect(network.map((s) => s.ref.id)).not.toContain(refs[0]!.id);

    // 'prospecting' returns ONLY prospect material
    const prospecting = await h.store.search({ text: "loss runs", audience: "prospecting" }, h.ctx);
    expect(prospecting.map((s) => s.ref.id)).toContain(refs[0]!.id);

    // 'all' sees everything
    const all = await h.store.search({ text: "loss runs", audience: "all" }, h.ctx);
    expect(all.map((s) => s.ref.id)).toContain(refs[0]!.id);

    // entity arm: degree-2 'Jane Doe' is invisible to network, visible to prospecting
    const networkEntities = await h.store.search({ text: "Jane Doe" }, h.ctx);
    expect(networkEntities.filter((s) => s.ref.kind === "entity")).toEqual([]);
    const prospectEntities = await h.store.search(
      { text: "Jane Doe", audience: "prospecting", entityTypes: ["person"] },
      h.ctx,
    );
    const entityHits = prospectEntities.filter((s) => s.ref.kind === "entity");
    expect(entityHits.length).toBe(1);
    expect(entityHits[0]!.excerpt).toBe("Jane Doe");
  });

  test("paths: BFS over links from degree-1 entities, scored by weight × strength", async () => {
    const h = await harness();
    const db = await freshDb();
    const at = nowIso();
    const originJson = h.origin;

    // fixture graph: alice (deg 1) knows target directly (w .8);
    // bob (deg 1) knows carol (deg 1) who knows target (w .9 × .9);
    // mallory (deg 2, prospect) also knows target — NOT a usable route.
    const ids = {
      alice: newUlid(),
      bob: newUlid(),
      carol: newUlid(),
      mallory: newUlid(),
      target: newUlid(),
    };
    const mk = async (id: string, slug: string, name: string, degree: number): Promise<void> => {
      await db.sql`
        insert into context.entities (id, tenant_id, type, slug, name, attrs, degree, origin, revision, created_at, updated_at)
        values (${id}, ${h.tenantId}, 'person', ${slug}, ${name}, '{}', ${degree}, ${originJson}::jsonb, 0, ${at}, ${at})`;
    };
    await mk(ids.alice, "alice", "Alice", 1);
    await mk(ids.bob, "bob", "Bob", 1);
    await mk(ids.carol, "carol", "Carol", 1);
    await mk(ids.mallory, "mallory", "Mallory", 2);
    await mk(ids.target, "tara-target", "Tara Target", 2);
    const link = async (a: string, b: string, verb: string, w: number): Promise<void> => {
      await db.sql`
        insert into context.links (id, tenant_id, from_ref, to_ref, verb, weight, origin, created_at, updated_at)
        values (${newUlid()}, ${h.tenantId},
                ${{ kind: "entity", id: a }}::jsonb,
                ${{ kind: "entity", id: b }}::jsonb,
                ${verb}, ${w}, ${originJson}::jsonb, ${at}, ${at})`;
    };
    await link(ids.alice, ids.target, "knows", 0.8);
    await link(ids.bob, ids.carol, "knows", 0.9);
    await link(ids.carol, ids.target, "worked_with", 0.9);
    await link(ids.mallory, ids.target, "knows", 1.0);
    // strength scores: alice strong (llm judgment overrides code), bob default
    await db.sql`
      insert into context.relationship_scores (tenant_id, entity_id, kind, value, method, computed_at)
      values (${h.tenantId}, ${ids.alice}, 'strength', '0.4', 'code', ${at}),
             (${h.tenantId}, ${ids.alice}, 'strength', '0.9', 'llm', ${at})`;

    const paths = await h.store.paths({ kind: "entity", id: ids.target }, h.ctx);
    expect(paths.length).toBe(3); // alice direct, carol direct, bob→carol 2-hop
    // alice direct: 0.9 (llm strength) × 0.8 = 0.72 — the top path
    expect(paths[0]!.hops.map((r) => r.id)).toEqual([ids.alice, ids.target]);
    expect(paths[0]!.score).toBeCloseTo(0.72);
    expect(paths[0]!.why).toContain("Alice");
    expect(paths[0]!.why).toContain("Tara Target");
    // bob's 2-hop route exists and is damped
    const bobPath = paths.find((p) => p.hops[0]!.id === ids.bob)!;
    expect(bobPath.hops.map((r) => r.id)).toEqual([ids.bob, ids.carol, ids.target]);
    expect(bobPath.score).toBeCloseTo(0.5 * 0.9 * 0.9 * 0.5); // default strength × w × w × damping
    expect(bobPath.why).toContain("Carol");
    // mallory (degree 2) never appears as a start
    expect(paths.some((p) => p.hops[0]!.id === ids.mallory)).toBe(false);

    expect(h.store.paths({ kind: "entity", id: newUlid() }, h.ctx)).rejects.toThrow(/not found/);
  });

  test("tenant isolation: another tenant's search sees nothing", async () => {
    const h = await harness();
    await Promise.all(EMAILS.map((e) => ingestText(h, ...e)));
    const otherCtx = { tenantId: newUlid(), principalId: h.principalId, kind: "human" as const };
    expect(await h.store.search({ text: "loss runs" }, otherCtx)).toEqual([]);
  });
});
