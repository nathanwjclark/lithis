import { describe, expect, test } from "bun:test";
import { newUlid } from "@lithis/core";
import { matchesSelector, topicGlobMatches } from "../src/spine/selector";

describe("topicGlobMatches", () => {
  const cases: [glob: string, topic: string, expected: boolean][] = [
    // exact
    ["context.doc.created", "context.doc.created", true],
    ["context.doc.created", "context.doc.distilled", false],
    // trailing * = one-or-more segments
    ["context.*", "context.doc.created", true],
    ["context.*", "context.blob.created", true],
    ["context.*", "work.item.opened", false],
    ["context.doc.*", "context.doc.created", true],
    ["context.doc.*", "context.doc", false],
    ["iam.*", "iam.tenant.created", true],
    // mid-position * = exactly one segment
    ["context.*.created", "context.doc.created", true],
    ["context.*.created", "context.doc.distilled", false],
    ["*.item.opened", "work.item.opened", true],
    // length mismatches without trailing *
    ["context.doc", "context.doc.created", false],
    ["context.doc.created.extra", "context.doc.created", false],
    // no partial-segment matching
    ["context.do*", "context.doc.created", false],
  ];
  test.each(cases)("%s vs %s → %p", (glob, topic, expected) => {
    expect(topicGlobMatches(glob, topic)).toBe(expected);
  });
});

describe("matchesSelector", () => {
  const event = {
    topic: "context.doc.created",
    subjectRefs: [
      { kind: "doc" as const, id: newUlid() },
      { kind: "blob" as const, id: newUlid() },
    ],
  };

  test("empty selector matches everything", () => {
    expect(matchesSelector(event, {})).toBe(true);
    expect(matchesSelector(event, { topics: [], subjectKinds: [] })).toBe(true);
  });

  test("topics alone", () => {
    expect(matchesSelector(event, { topics: ["context.*"] })).toBe(true);
    expect(matchesSelector(event, { topics: ["work.*"] })).toBe(false);
    expect(matchesSelector(event, { topics: ["work.*", "context.doc.*"] })).toBe(true);
  });

  test("subjectKinds alone — any ref kind in the list matches", () => {
    expect(matchesSelector(event, { subjectKinds: ["doc"] })).toBe(true);
    expect(matchesSelector(event, { subjectKinds: ["entity"] })).toBe(false);
    expect(matchesSelector(event, { subjectKinds: ["entity", "blob"] })).toBe(true);
  });

  test("topics AND subjectKinds compose", () => {
    expect(matchesSelector(event, { topics: ["context.*"], subjectKinds: ["doc"] })).toBe(true);
    expect(matchesSelector(event, { topics: ["context.*"], subjectKinds: ["entity"] })).toBe(false);
    expect(matchesSelector(event, { topics: ["work.*"], subjectKinds: ["doc"] })).toBe(false);
  });
});
