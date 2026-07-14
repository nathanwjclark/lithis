/**
 * Pure helpers over the server's stub census (/stubs). REAL code, unit tested.
 */

import type { StubRecord } from "@lithis/stubkit";

export interface CensusGroup {
  /** Area prefix, e.g. "server.context" or "sdk.connectors". */
  area: string;
  records: StubRecord[];
  /** Number of records in this group that have been invoked at least once. */
  invoked: number;
  /** Total invocation count across the group. */
  invocations: number;
}

/** Area prefix of a stub id: the first two dot segments (or the whole id if shorter). */
export function areaOf(stubId: string): string {
  const parts = stubId.split(".");
  const first = parts[0] ?? stubId;
  const second = parts[1];
  return parts.length >= 2 && second !== undefined ? `${first}.${second}` : first;
}

/** Group census records by area prefix; groups and records are sorted by id. */
export function groupCensus(records: readonly StubRecord[]): CensusGroup[] {
  const byArea = new Map<string, CensusGroup>();
  for (const record of records) {
    const area = areaOf(record.id);
    let group = byArea.get(area);
    if (!group) {
      group = { area, records: [], invoked: 0, invocations: 0 };
      byArea.set(area, group);
    }
    group.records.push(record);
    group.invocations += record.invocations;
    if (record.invocations > 0) group.invoked += 1;
  }
  const groups = [...byArea.values()].sort((a, b) => a.area.localeCompare(b.area));
  for (const group of groups) {
    group.records.sort((a, b) => a.id.localeCompare(b.id));
  }
  return groups;
}

/** Records whose id starts with any of the given prefixes, sorted by id. */
export function filterByPrefixes(
  records: readonly StubRecord[],
  prefixes: readonly string[],
): StubRecord[] {
  return records
    .filter((record) => prefixes.some((prefix) => record.id.startsWith(prefix)))
    .sort((a, b) => a.id.localeCompare(b.id));
}
