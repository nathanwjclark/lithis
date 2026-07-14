import { describe, expect, test } from "bun:test";
import { fuseRanked, reciprocalRankFusion, RRF_K } from "../src/context/fusion";

describe("reciprocalRankFusion", () => {
  test("scores a single list by weight / (K + rank)", () => {
    const scores = reciprocalRankFusion([{ weight: 1, keys: ["a", "b"] }]);
    expect(scores.get("a")).toBeCloseTo(1 / (RRF_K + 1));
    expect(scores.get("b")).toBeCloseTo(1 / (RRF_K + 2));
  });

  test("sums contributions across arms", () => {
    const scores = reciprocalRankFusion([
      { weight: 1, keys: ["a", "b"] },
      { weight: 1, keys: ["b", "a"] },
    ]);
    // both appear at ranks 1 and 2 across the two arms — identical fused score
    expect(scores.get("a")).toBeCloseTo(scores.get("b")!);
    expect(scores.get("a")).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2));
  });

  test("a key present in two arms beats a same-rank key present in one", () => {
    const ranked = fuseRanked([
      { weight: 1, keys: ["both", "only-fts"] },
      { weight: 1, keys: ["both"] },
    ]);
    expect(ranked[0]!.key).toBe("both");
    expect(ranked[1]!.key).toBe("only-fts");
  });

  test("arm weights scale contributions (entity arm at 0.5 loses to FTS at 1.0)", () => {
    const ranked = fuseRanked([
      { weight: 1.0, keys: ["doc-hit"] },
      { weight: 0.5, keys: ["entity-hit"] },
    ]);
    expect(ranked[0]!.key).toBe("doc-hit");
    expect(ranked[0]!.score).toBeCloseTo(2 * ranked[1]!.score);
  });

  test("duplicate keys within one arm keep their best rank only", () => {
    const scores = reciprocalRankFusion([{ weight: 1, keys: ["a", "a", "a"] }]);
    expect(scores.get("a")).toBeCloseTo(1 / (RRF_K + 1));
  });

  test("fuseRanked breaks score ties deterministically by key", () => {
    const ranked = fuseRanked([{ weight: 1, keys: ["z"] }, { weight: 1, keys: ["a"] }]);
    expect(ranked.map((r) => r.key)).toEqual(["a", "z"]);
  });

  test("empty input fuses to empty output", () => {
    expect(fuseRanked([])).toEqual([]);
    expect(fuseRanked([{ weight: 1, keys: [] }])).toEqual([]);
  });
});
