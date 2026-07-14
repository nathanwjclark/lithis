import { describe, expect, test } from "bun:test";
import { schemaPackSchema } from "@lithis/core";
import { insuranceSchemaPack } from "../src/schema-pack";

describe("insurance-brokerage SchemaPack", () => {
  test("validates directly against schemaPackSchema (no server-assigned fields)", () => {
    expect(() => schemaPackSchema.parse(insuranceSchemaPack)).not.toThrow();
  });

  test("declares carrier and policy_line entity types", () => {
    expect(insuranceSchemaPack.entityTypes.map((e) => e.type).sort()).toEqual(["carrier", "policy_line"]);
  });

  test("declares the underwriting doc types", () => {
    expect(insuranceSchemaPack.docTypes.map((d) => d.type).sort()).toEqual([
      "acord_submission",
      "binder",
      "loss_run",
      "quote",
    ]);
  });

  test("link verbs come in inverse pairs", () => {
    const byVerb = new Map(insuranceSchemaPack.linkVerbs.map((v) => [v.verb, v]));
    expect([...byVerb.keys()].sort()).toEqual([
      "broker_of",
      "brokered_by",
      "insured_by",
      "insures",
      "quoted",
      "quoted_by",
    ]);
    for (const v of insuranceSchemaPack.linkVerbs) {
      expect(v.inverse).toBeDefined();
      const inverse = byVerb.get(v.inverse ?? "");
      expect(inverse?.inverse).toBe(v.verb);
    }
  });
});
