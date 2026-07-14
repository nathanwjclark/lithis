import { describe, expect, test } from "bun:test";
import { processTemplateSchema } from "@lithis/core";
import { underwritingSmbTemplate } from "../src/process-underwriting";
import { serverFields } from "./fixtures";

/** Draft validation derived from the core shape: draft + fixture server fields must parse fully. */
describe("underwriting-smb ProcessTemplate draft", () => {
  test("parses as a full ProcessTemplate once server fields are attached", () => {
    const full = processTemplateSchema.parse({ ...serverFields(), ...underwritingSmbTemplate });
    expect(full.slug).toBe("underwriting-smb");
    expect(full.mode).toBe("fixed");
  });

  test("has the eight underwriting nodes", () => {
    expect(underwritingSmbTemplate.nodes.map((n) => n.key)).toEqual([
      "intake",
      "loss_history_analysis",
      "exposure_analysis",
      "carrier_appetite_match",
      "quote_comparison",
      "compliance_check",
      "proposal_draft",
      "bind_request",
    ]);
  });

  test("gates: money/liability nodes always gate; intake never does", () => {
    const gates = Object.fromEntries(underwritingSmbTemplate.nodes.map((n) => [n.key, n.gate]));
    expect(gates["intake"]).toBe("never");
    for (const key of ["loss_history_analysis", "quote_comparison", "compliance_check", "bind_request"]) {
      expect(gates[key]).toBe("always");
    }
    for (const key of ["exposure_analysis", "carrier_appetite_match", "proposal_draft"]) {
      expect(gates[key]).toBe("auto_below_threshold");
    }
  });

  test("change policy: fixed graph, compliance_check and bind_request protected", () => {
    expect(underwritingSmbTemplate.changePolicy.allowAddNodes).toBe(false);
    expect(underwritingSmbTemplate.changePolicy.allowSkip).toBe(false);
    expect(underwritingSmbTemplate.changePolicy.protectedNodes.sort()).toEqual([
      "bind_request",
      "compliance_check",
    ]);
  });

  test("edges encode the real dependencies", () => {
    const deps = (key: string) =>
      underwritingSmbTemplate.edges.filter((e) => e.from === key).map((e) => e.to).sort();
    expect(deps("loss_history_analysis")).toEqual(["intake"]);
    expect(deps("carrier_appetite_match")).toEqual(["exposure_analysis", "loss_history_analysis"]);
    expect(deps("compliance_check")).toEqual(["quote_comparison"]);
    expect(deps("bind_request")).toEqual(["compliance_check", "proposal_draft"]);
  });

  test("the dependency graph is acyclic", () => {
    const nodes = underwritingSmbTemplate.nodes.map((n) => n.key);
    const dependsOn = new Map<string, string[]>(
      nodes.map((k) => [k, underwritingSmbTemplate.edges.filter((e) => e.from === k).map((e) => e.to)]),
    );
    const state = new Map<string, "visiting" | "done">();
    const visit = (key: string): boolean => {
      const s = state.get(key);
      if (s === "visiting") return false;
      if (s === "done") return true;
      state.set(key, "visiting");
      for (const dep of dependsOn.get(key) ?? []) {
        if (!visit(dep)) return false;
      }
      state.set(key, "done");
      return true;
    };
    expect(nodes.every(visit)).toBe(true);
  });

  test("every gated node declares an evidenceSpec and a result schema ref", () => {
    for (const node of underwritingSmbTemplate.nodes) {
      expect(node.resultSchemaRef.length).toBeGreaterThan(0);
      if (node.gate !== "never") {
        expect(node.evidenceSpec ?? "").not.toBe("");
      }
    }
  });

  test("input selectors reference the pack's doc types", () => {
    const docTypes = new Set(
      underwritingSmbTemplate.nodes.flatMap((n) => n.inputSelectors.flatMap((s) => s.docTypes ?? [])),
    );
    for (const t of docTypes) {
      expect(["loss_run", "acord_submission", "quote", "binder"]).toContain(t);
    }
  });
});
