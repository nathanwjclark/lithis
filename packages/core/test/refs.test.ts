import { describe, expect, test } from "bun:test";
import { REF_KINDS, newUlid, ref, refSchema, refToString, sameRef } from "@lithis/core";

describe("Ref / RefKind closure", () => {
  test("every declared kind parses", () => {
    for (const kind of REF_KINDS) {
      expect(refSchema.safeParse({ kind, id: newUlid() }).success).toBe(true);
    }
  });

  test("unknown kinds are rejected — the enum is CLOSED", () => {
    expect(refSchema.safeParse({ kind: "flag", id: newUlid() }).success).toBe(false);
    expect(refSchema.safeParse({ kind: "rule", id: newUlid() }).success).toBe(false);
    expect(refSchema.safeParse({ kind: "mandate", id: newUlid() }).success).toBe(false);
  });

  test("removed post-amendment kinds stay removed (flag/rule/mandate)", () => {
    const kinds: readonly string[] = REF_KINDS;
    expect(kinds).not.toContain("flag");
    expect(kinds).not.toContain("rule");
    expect(kinds).not.toContain("mandate");
    expect(kinds).toContain("session");
  });

  test("helpers", () => {
    const id = newUlid();
    const a = ref("doc", id);
    expect(sameRef(a, { kind: "doc", id })).toBe(true);
    expect(sameRef(a, { kind: "blob", id })).toBe(false);
    expect(refToString(a)).toBe(`doc:${id}`);
  });
});
