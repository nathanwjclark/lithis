import { describe, expect, test } from "bun:test";
import {
  blobSchema,
  docSchema,
  entitySchema,
  linkSchema,
  newUlid,
  relationshipScoreSchema,
  schemaPackSchema,
  nowIso,
} from "@lithis/core";
import { agentOrigin, baseRecord, connectorOrigin, ids } from "./fixtures";

describe("Blob", () => {
  test("round-trips with connector origin and partner trust", () => {
    const blob = blobSchema.parse({
      ...baseRecord(ids.blob),
      sha256: "a".repeat(64),
      mediaType: "application/pdf",
      sizeBytes: 123_456,
      storageRef: "s3://lithis-tenant/blobs/loss-run.pdf",
      origin: connectorOrigin(),
    });
    expect(blob.origin.trust).toBe("partner");
    expect(blob.origin.by.kind).toBe("connection");
  });

  test("rejects invalid sha256", () => {
    expect(
      blobSchema.safeParse({
        ...baseRecord(newUlid()),
        sha256: "nope",
        mediaType: "text/plain",
        sizeBytes: 1,
        storageRef: "s3://x",
        origin: connectorOrigin(),
      }).success,
    ).toBe(false);
  });
});

describe("Doc", () => {
  test("quarantined defaults to TRUE — ingested content is data, not instructions", () => {
    const doc = docSchema.parse({
      ...baseRecord(ids.doc),
      revision: 0,
      type: "loss_run",
      slug: "acme-loss-run-2026",
      title: "Acme Logistics loss run 2023-2026",
      bodyBlobId: ids.blob,
      frontmatter: { carrier: "Hartford" },
      origin: connectorOrigin(),
    });
    expect(doc.quarantined).toBe(true);
    expect(doc.summary).toBeUndefined(); // distill writes this later
  });

  test("has NO epistemology fields (post-amendment)", () => {
    const parsed = docSchema.parse({
      ...baseRecord(newUlid()),
      revision: 0,
      type: "note",
      slug: "n1",
      title: "n1",
      bodyBlobId: ids.blob,
      frontmatter: {},
      origin: agentOrigin(),
      // unknown keys are stripped, so grading fields cannot ride along
      epistemology: { status: "confirmed", confidence: 0.9 },
    } as Record<string, unknown>);
    expect("epistemology" in parsed).toBe(false);
  });
});

describe("Entity degree guard", () => {
  test("person/company REQUIRE degree", () => {
    const noDegree = entitySchema.safeParse({
      ...baseRecord(newUlid()),
      revision: 0,
      type: "person",
      slug: "rick-fonte",
      name: "Rick Fonte",
      attrs: {},
      origin: agentOrigin(),
    });
    expect(noDegree.success).toBe(false);

    const prospect = entitySchema.parse({
      ...baseRecord(ids.entityPerson),
      revision: 0,
      type: "person",
      slug: "rick-fonte",
      name: "Rick Fonte",
      attrs: { headline: "Tax Partner" },
      degree: 2,
      origin: agentOrigin(),
    });
    expect(prospect.degree).toBe(2);
  });

  test("projects/concepts don't need degree", () => {
    const project = entitySchema.safeParse({
      ...baseRecord(newUlid()),
      revision: 0,
      type: "project",
      slug: "nj-licensing",
      name: "NJ brokerage licensing",
      attrs: {},
      origin: agentOrigin(),
    });
    expect(project.success).toBe(true);
  });
});

describe("Link / SchemaPack / RelationshipScore", () => {
  test("links carry origin (who asserted, in which session)", () => {
    const link = linkSchema.parse({
      ...baseRecord(newUlid()),
      fromRef: { kind: "entity", id: ids.entityPerson },
      toRef: { kind: "entity", id: ids.entityCompany },
      verb: "works_at",
      origin: agentOrigin(),
    });
    expect(link.origin.sessionId).toBe(ids.session);
    expect(link.weight).toBe(1);
  });

  test("schema pack validates verbs and retype rules", () => {
    const pack = schemaPackSchema.parse({
      slug: "insurance-brokerage",
      version: "0.1.0",
      entityTypes: [{ type: "carrier", description: "An insurance carrier" }],
      docTypes: [{ type: "loss_run", description: "Carrier loss-run report" }],
      linkVerbs: [{ verb: "insures", description: "carrier insures client", inverse: "insured_by" }],
      retypeRules: [{ from: "insurer", to: "carrier" }],
    });
    expect(pack.linkVerbs[0]?.inverse).toBe("insured_by");
  });

  test("scores record method so det runs never masquerade as judgment", () => {
    const score = relationshipScoreSchema.parse({
      tenantId: ids.tenant,
      entityId: ids.entityPerson,
      kind: "strength",
      value: 0.84,
      method: "code",
      computedAt: nowIso(),
    });
    expect(score.method).toBe("code");
  });
});
