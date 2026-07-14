import type { Event, NodeDef, Ref, WatchRule } from "@lithis/core";

/**
 * Pure process-graph logic — no I/O, unit-tested in
 * apps/server/test/processes.invalidator.test.ts. Edges here use the template
 * convention `{ from, to }` = "from depends_on to" (from is the dependent,
 * to is the upstream), matching both ProcessTemplate.edges and
 * work.work_edges rows mapped through node keys.
 */

export interface KeyEdge {
  from: string;
  to: string;
}

export class UnknownNodeKeyError extends Error {
  constructor(key: string) {
    super(`process graph has no node '${key}'`);
    this.name = "UnknownNodeKeyError";
  }
}

export class ProcessGraphCycleError extends Error {
  constructor(keys: string[]) {
    super(`process graph has a depends_on cycle among: ${keys.join(", ")}`);
    this.name = "ProcessGraphCycleError";
  }
}

/**
 * Topological order over depends_on edges: upstreams before dependents, ties
 * broken by key so instantiation is deterministic. Throws on cycles.
 */
export function topoOrder(keys: string[], edges: KeyEdge[]): string[] {
  const keySet = new Set(keys);
  for (const e of edges) {
    if (!keySet.has(e.from)) throw new UnknownNodeKeyError(e.from);
    if (!keySet.has(e.to)) throw new UnknownNodeKeyError(e.to);
  }
  const remainingUpstreams = new Map<string, Set<string>>(
    keys.map((k) => [k, new Set(edges.filter((e) => e.from === k).map((e) => e.to))]),
  );
  const order: string[] = [];
  const placed = new Set<string>();
  while (order.length < keys.length) {
    const free = keys
      .filter((k) => !placed.has(k))
      .filter((k) => [...remainingUpstreams.get(k)!].every((up) => placed.has(up)))
      .sort();
    if (free.length === 0) {
      throw new ProcessGraphCycleError(keys.filter((k) => !placed.has(k)).sort());
    }
    for (const k of free) {
      order.push(k);
      placed.add(k);
    }
  }
  return order;
}

/**
 * The transitive depends_on dependents of `dirty` — the CascadePlan's
 * `affected`, in BFS order (direct dependents first), deduplicated.
 */
export function walkDependents(dirty: string, edges: KeyEdge[]): string[] {
  const dependentsOf = new Map<string, string[]>();
  for (const e of edges) {
    const list = dependentsOf.get(e.to) ?? [];
    list.push(e.from);
    dependentsOf.set(e.to, list);
  }
  const affected: string[] = [];
  const seen = new Set<string>([dirty]);
  const queue = [dirty];
  while (queue.length > 0) {
    const key = queue.shift()!;
    for (const dep of (dependentsOf.get(key) ?? []).sort()) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      affected.push(dep);
      queue.push(dep);
    }
  }
  return affected;
}

/** Ids named by an event that a WatchRule's entityRefs can match against. */
function eventEntityIds(e: Event): Set<string> {
  const ids = new Set<string>();
  for (const ref of e.subjectRefs) {
    if (ref.kind === "entity") ids.add(ref.id);
  }
  const payload = e.payload as Record<string, unknown> | undefined;
  const entityIds = payload?.["entityIds"];
  if (Array.isArray(entityIds)) {
    for (const id of entityIds) {
      if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}

/**
 * Deterministic WatchRule matching — pure code decides. Every present
 * constraint must hold (AND semantics); constraints the event cannot answer
 * (a docTypes rule against an event with no docType payload, a pathGlobs
 * rule — no event carries a path today) fail closed: no match, never a guess.
 */
export function matchesWatchRule(match: WatchRule["match"], e: Event): boolean {
  if (!match.topics.includes(e.topic)) return false;
  const payload = e.payload as Record<string, unknown> | undefined;
  if (match.docTypes !== undefined) {
    const docType = payload?.["docType"];
    if (typeof docType !== "string" || !match.docTypes.includes(docType)) return false;
  }
  if (match.entityRefs !== undefined) {
    const ids = eventEntityIds(e);
    if (!match.entityRefs.some((r) => ids.has(r.id))) return false;
  }
  if (match.connectorKinds !== undefined) {
    const slug = payload?.["connectorSlug"];
    if (typeof slug !== "string" || !match.connectorKinds.includes(slug)) return false;
  }
  if (match.pathGlobs !== undefined) {
    // No registered event payload carries a path yet — fail closed.
    return false;
  }
  return true;
}

/** What instantiate() persists per bound rule (id/tenant/run assigned there). */
export type BoundRule = Pick<WatchRule, "nodeKey" | "match" | "mode">;

/**
 * Bind a node's input selectors × instance bindings into deterministic
 * WatchRules:
 * - selector.docTypes → a context.doc.created rule on those doc types (the
 *   walkthrough's "path/type rules may fire on created");
 * - selector.entityRefs (concrete, dynamic graphs) or — for selectors that
 *   read the world via query — the bindings' entity refs → a
 *   context.doc.distilled rule ("entity-scoped WatchRules subscribe to
 *   distilled").
 * fromNodes-only selectors bind nothing: upstream reruns already cascade
 * through depends_on edges.
 */
export function bindWatchRules(nodes: NodeDef[], bindings: Record<string, Ref>): BoundRule[] {
  const boundEntities = Object.values(bindings).filter((r) => r.kind === "entity");
  const rules: BoundRule[] = [];
  for (const node of nodes) {
    for (const sel of node.inputSelectors) {
      if (sel.docTypes !== undefined && sel.docTypes.length > 0) {
        rules.push({
          nodeKey: node.key,
          mode: "deterministic",
          match: { topics: ["context.doc.created"], docTypes: sel.docTypes },
        });
      }
      const entityRefs =
        sel.entityRefs !== undefined && sel.entityRefs.length > 0
          ? sel.entityRefs
          : sel.query !== undefined
            ? boundEntities
            : [];
      if (entityRefs.length > 0) {
        rules.push({
          nodeKey: node.key,
          mode: "deterministic",
          match: { topics: ["context.doc.distilled"], entityRefs },
        });
      }
    }
  }
  return rules;
}
