/**
 * Score fusion for hybrid search: weighted Reciprocal Rank Fusion (RRF).
 *
 * Each arm (FTS, vector, entity-name) contributes a ranked list of keys.
 * A key's fused score is Σ over arms containing it of weight / (K + rank),
 * rank 1-based, K = 60 (the standard RRF damping constant). RRF was chosen
 * over score normalization because ts_rank and cosine distance live on
 * incomparable scales — ranks are the only thing safely shared.
 */

export const RRF_K = 60;

export interface RankedList {
  /** Relative arm weight (e.g. FTS 1.0, vector 1.0, entities 0.5). */
  weight: number;
  /** Keys in rank order, best first. Duplicate keys keep their best rank. */
  keys: string[];
}

export function reciprocalRankFusion(lists: RankedList[], k: number = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.keys.forEach((key, i) => {
      if (seen.has(key)) return; // best (earliest) rank wins within one arm
      seen.add(key);
      scores.set(key, (scores.get(key) ?? 0) + list.weight / (k + i + 1));
    });
  }
  return scores;
}

/** Fused keys sorted best-first (stable tiebreak on key for determinism). */
export function fuseRanked(lists: RankedList[], k: number = RRF_K): { key: string; score: number }[] {
  return [...reciprocalRankFusion(lists, k).entries()]
    .map(([key, score]) => ({ key, score }))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}
