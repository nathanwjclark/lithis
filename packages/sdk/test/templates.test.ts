import { describe, expect, test } from "bun:test";
import { defineTemplateSpec, templateSpecSchema } from "../src/templates";

const valid = {
  slug: "quote-letter",
  version: "1.0.0",
  kind: "document" as const,
  fieldsSchema: {
    type: "object",
    properties: { insured: { type: "string" }, premium: { type: "number" } },
  },
  checks: [
    { kind: "deterministic" as const, ref: "checks/premium-matches-rating.ts" },
    { kind: "rubric" as const, prompt: "Does the letter state the binding conditions?" },
  ],
};

describe("defineTemplateSpec", () => {
  test("round-trips a valid authoring spec", () => {
    const spec = defineTemplateSpec(valid);
    expect(spec.slug).toBe("quote-letter");
    expect(spec.kind).toBe("document");
    expect(spec.checks).toHaveLength(2);
    expect(spec.approvalPolicy).toBe("always"); // core default
  });

  test("has no server-assigned fields (ids, blob ids, approval request)", () => {
    const shape = templateSpecSchema.shape as Record<string, unknown>;
    for (const field of [
      "id",
      "tenantId",
      "createdAt",
      "updatedAt",
      "bodyBlobId",
      "approvalRequestId",
    ]) {
      expect(shape[field]).toBeUndefined();
    }
    // ...and the authored fields are all present.
    for (const field of ["slug", "version", "kind", "fieldsSchema", "checks"]) {
      expect(shape[field]).toBeDefined();
    }
  });

  test("defaults checks to [] when omitted", () => {
    const { checks: _checks, ...withoutChecks } = valid;
    expect(defineTemplateSpec(withoutChecks).checks).toEqual([]);
  });

  test("rejects an unknown template kind", () => {
    expect(() => defineTemplateSpec({ ...valid, kind: "spreadsheet" as never })).toThrow();
  });

  test("rejects a check with a bad discriminator", () => {
    expect(() =>
      defineTemplateSpec({
        ...valid,
        checks: [{ kind: "vibes", prompt: "looks good?" } as never],
      }),
    ).toThrow();
  });
});
