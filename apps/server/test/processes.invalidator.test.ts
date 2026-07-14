import { describe, expect, test } from "bun:test";
import { newUlid } from "@lithis/core";
import type { Event, NodeDef, Ref } from "@lithis/core";
import {
  ProcessGraphCycleError,
  UnknownNodeKeyError,
  bindWatchRules,
  matchesWatchRule,
  topoOrder,
  walkDependents,
} from "../src/processes";

/**
 * Pure Invalidator logic — fixture graphs shaped like the underwriting
 * template (edge {from,to} = "from depends_on to").
 */

const UNDERWRITING_EDGES = [
  { from: "loss_history_analysis", to: "intake" },
  { from: "exposure_analysis", to: "intake" },
  { from: "carrier_appetite_match", to: "loss_history_analysis" },
  { from: "carrier_appetite_match", to: "exposure_analysis" },
  { from: "quote_comparison", to: "carrier_appetite_match" },
  { from: "compliance_check", to: "quote_comparison" },
  { from: "proposal_draft", to: "quote_comparison" },
  { from: "proposal_draft", to: "compliance_check" },
  { from: "bind_request", to: "proposal_draft" },
  { from: "bind_request", to: "compliance_check" },
];
const UNDERWRITING_KEYS = [
  "intake",
  "loss_history_analysis",
  "exposure_analysis",
  "carrier_appetite_match",
  "quote_comparison",
  "compliance_check",
  "proposal_draft",
  "bind_request",
];

function event(topic: string, payload: unknown, subjectRefs: Ref[] = []): Event {
  return {
    id: newUlid(),
    tenantId: newUlid(),
    seq: 1n,
    topic,
    subjectRefs,
    payload,
    actor: { kind: "tenant", id: newUlid() },
    at: new Date().toISOString(),
  };
}

describe("topoOrder", () => {
  test("upstreams always precede dependents; deterministic tie-break", () => {
    const order = topoOrder(UNDERWRITING_KEYS, UNDERWRITING_EDGES);
    const pos = new Map(order.map((k, i) => [k, i]));
    for (const e of UNDERWRITING_EDGES) {
      expect(pos.get(e.to)!).toBeLessThan(pos.get(e.from)!);
    }
    expect(order[0]).toBe("intake");
    expect(order.at(-1)).toBe("bind_request");
    expect(topoOrder(UNDERWRITING_KEYS, UNDERWRITING_EDGES)).toEqual(order);
  });

  test("cycle → ProcessGraphCycleError; unknown key → UnknownNodeKeyError", () => {
    expect(() =>
      topoOrder(["a", "b"], [{ from: "a", to: "b" }, { from: "b", to: "a" }]),
    ).toThrow(ProcessGraphCycleError);
    expect(() => topoOrder(["a"], [{ from: "a", to: "ghost" }])).toThrow(UnknownNodeKeyError);
  });
});

describe("walkDependents", () => {
  test("transitive dependents in BFS order, diamond deduplicated", () => {
    expect(walkDependents("quote_comparison", UNDERWRITING_EDGES)).toEqual([
      "compliance_check",
      "proposal_draft",
      "bind_request",
    ]);
    expect(walkDependents("intake", UNDERWRITING_EDGES)).toEqual([
      "exposure_analysis",
      "loss_history_analysis",
      "carrier_appetite_match",
      "quote_comparison",
      "compliance_check",
      "proposal_draft",
      "bind_request",
    ]);
  });

  test("a leaf has no dependents", () => {
    expect(walkDependents("bind_request", UNDERWRITING_EDGES)).toEqual([]);
  });
});

describe("matchesWatchRule", () => {
  test("docTypes rule: topic + docType must both match", () => {
    const match = { topics: ["context.doc.created"], docTypes: ["loss_run"] };
    expect(matchesWatchRule(match, event("context.doc.created", { docType: "loss_run" }))).toBe(true);
    expect(matchesWatchRule(match, event("context.doc.created", { docType: "quote" }))).toBe(false);
    expect(matchesWatchRule(match, event("context.doc.distilled", { docType: "loss_run" }))).toBe(false);
  });

  test("entityRefs rule: matches payload entityIds or entity subjectRefs", () => {
    const caseEntity = newUlid();
    const match = {
      topics: ["context.doc.distilled"],
      entityRefs: [{ kind: "entity", id: caseEntity } as Ref],
    };
    expect(
      matchesWatchRule(match, event("context.doc.distilled", { entityIds: [caseEntity], linkIds: [] })),
    ).toBe(true);
    expect(
      matchesWatchRule(match, event("context.doc.distilled", { entityIds: [], linkIds: [] }, [
        { kind: "entity", id: caseEntity },
      ])),
    ).toBe(true);
    expect(
      matchesWatchRule(match, event("context.doc.distilled", { entityIds: [newUlid()], linkIds: [] })),
    ).toBe(false);
  });

  test("unanswerable constraints fail closed (docType absent, pathGlobs)", () => {
    expect(
      matchesWatchRule(
        { topics: ["context.doc.distilled"], docTypes: ["loss_run"] },
        event("context.doc.distilled", { entityIds: [], linkIds: [] }),
      ),
    ).toBe(false);
    expect(
      matchesWatchRule(
        { topics: ["context.doc.created"], pathGlobs: ["/cases/**"] },
        event("context.doc.created", { docType: "loss_run" }),
      ),
    ).toBe(false);
  });

  test("connectorKinds match against payload connectorSlug", () => {
    const match = { topics: ["context.doc.created"], connectorKinds: ["filedrop"] };
    expect(
      matchesWatchRule(match, event("context.doc.created", { docType: "x", connectorSlug: "filedrop" })),
    ).toBe(true);
    expect(matchesWatchRule(match, event("context.doc.created", { docType: "x" }))).toBe(false);
  });
});

describe("bindWatchRules", () => {
  const caseEntity: Ref = { kind: "entity", id: newUlid() };
  const nodes: NodeDef[] = [
    {
      key: "loss_history_analysis",
      title: "Loss history analysis",
      instructions: "analyze loss runs",
      inputSelectors: [
        { description: "loss runs", docTypes: ["loss_run"] },
        { description: "case facts", fromNodes: ["intake"] },
      ],
      resultSchemaRef: "test/loss@1",
      gate: "always",
    },
    {
      key: "carrier_appetite_match",
      title: "Carrier appetite match",
      instructions: "match appetite",
      inputSelectors: [{ description: "appetite guides", query: "carrier appetite guide" }],
      resultSchemaRef: "test/appetite@1",
      gate: "auto_below_threshold",
    },
  ];

  test("docTypes selectors bind doc.created rules; query selectors bind the case entities to doc.distilled", () => {
    const rules = bindWatchRules(nodes, { case: caseEntity });
    expect(rules).toEqual([
      {
        nodeKey: "loss_history_analysis",
        mode: "deterministic",
        match: { topics: ["context.doc.created"], docTypes: ["loss_run"] },
      },
      {
        nodeKey: "carrier_appetite_match",
        mode: "deterministic",
        match: { topics: ["context.doc.distilled"], entityRefs: [caseEntity] },
      },
    ]);
  });

  test("fromNodes-only selectors bind nothing; no bindings → no entity rules", () => {
    expect(bindWatchRules(nodes, {})).toEqual([
      {
        nodeKey: "loss_history_analysis",
        mode: "deterministic",
        match: { topics: ["context.doc.created"], docTypes: ["loss_run"] },
      },
    ]);
  });
});
