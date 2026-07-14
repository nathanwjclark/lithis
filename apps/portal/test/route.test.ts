import { describe, expect, test } from "bun:test";
import { DEFAULT_SECTION_ID, parseRoute, SECTIONS, sectionFor } from "../src/ui/route";

describe("parseRoute", () => {
  test("parses #/section and #section forms", () => {
    expect(parseRoute("#/inbox")).toBe("inbox");
    expect(parseRoute("#inbox")).toBe("inbox");
    expect(parseRoute("#/stubs")).toBe("stubs");
  });

  test("first path segment wins; query and sub-paths ignored", () => {
    expect(parseRoute("#/work/123")).toBe("work");
    expect(parseRoute("#/processes?x=1")).toBe("processes");
  });

  test("is case-insensitive", () => {
    expect(parseRoute("#/Inbox")).toBe("inbox");
  });

  test("empty and unknown hashes fall back to home", () => {
    expect(parseRoute("")).toBe(DEFAULT_SECTION_ID);
    expect(parseRoute("#")).toBe(DEFAULT_SECTION_ID);
    expect(parseRoute("#/")).toBe(DEFAULT_SECTION_ID);
    expect(parseRoute("#/nope")).toBe(DEFAULT_SECTION_ID);
  });

  test("every declared section round-trips", () => {
    for (const section of SECTIONS) {
      expect(parseRoute(`#/${section.id}`)).toBe(section.id);
    }
  });
});

describe("SECTIONS", () => {
  test("section ids are unique", () => {
    const ids = SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("contains the full plain-language nav", () => {
    expect(SECTIONS.map((s) => s.label)).toEqual([
      "Home",
      "Inbox",
      "Work",
      "Processes",
      "People & Companies",
      "Documents",
      "Reports",
      "Connections",
      "Systems",
      "Compliance",
      "Workbench",
      "What's real yet",
    ]);
  });

  test("sectionFor falls back to home for unknown ids", () => {
    expect(sectionFor("nope").id).toBe(DEFAULT_SECTION_ID);
    expect(sectionFor("inbox").id).toBe("inbox");
  });
});
