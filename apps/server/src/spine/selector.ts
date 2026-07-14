import type { Event } from "@lithis/core";
import type { EventSelector } from "./index";

/**
 * Pure selector matching — the dispatcher scans events per tenant in seq order
 * and filters in-process with these (selectors are too dynamic to push into
 * SQL, and per-consumer scans stay index-friendly on (tenant_id, seq)).
 *
 * Glob semantics (dot-segmented):
 *   - `*` matches exactly one segment: "context.*.created" ✓ context.doc.created
 *   - a TRAILING `*` matches one-or-more segments: "context.*" ✓ everything
 *     under context; "context.doc.*" ✓ context.doc.created
 *   - no other wildcarding (no partial-segment matches)
 * Omitted/empty `topics` and `subjectKinds` each match everything; when both
 * are present the selector is the AND of the two; `subjectKinds` matches when
 * ANY subjectRef kind is in the list.
 */

export function topicGlobMatches(glob: string, topic: string): boolean {
  const globSegs = glob.split(".");
  const topicSegs = topic.split(".");
  for (let i = 0; i < globSegs.length; i++) {
    const g = globSegs[i]!;
    const isLast = i === globSegs.length - 1;
    if (g === "*" && isLast) {
      // trailing * matches one-or-more remaining segments
      return topicSegs.length > i;
    }
    if (i >= topicSegs.length) return false;
    if (g !== "*" && g !== topicSegs[i]) return false;
  }
  return topicSegs.length === globSegs.length;
}

export function matchesSelector(
  e: Pick<Event, "topic" | "subjectRefs">,
  sel: EventSelector,
): boolean {
  if (sel.topics !== undefined && sel.topics.length > 0) {
    if (!sel.topics.some((g) => topicGlobMatches(g, e.topic))) return false;
  }
  if (sel.subjectKinds !== undefined && sel.subjectKinds.length > 0) {
    if (!e.subjectRefs.some((r) => sel.subjectKinds!.includes(r.kind))) return false;
  }
  return true;
}
