/**
 * Hash routing — REAL, no router dependency. `#/inbox` (or `#inbox`) selects
 * the section with id `inbox`; anything unknown falls back to home.
 */

export interface Section {
  id: string;
  label: string;
  /**
   * Stub-census id prefixes relevant to this section. Not-yet-built pages list
   * the registered stubs behind them (fetched live from the server's /stubs
   * census) instead of faking content.
   */
  stubPrefixes: readonly string[];
}

export const SECTIONS: readonly Section[] = [
  { id: "home", label: "Home", stubPrefixes: [] },
  { id: "inbox", label: "Inbox", stubPrefixes: ["server.humangate.", "server.delivery."] },
  { id: "work", label: "Work", stubPrefixes: ["server.work."] },
  { id: "processes", label: "Processes", stubPrefixes: ["server.processes."] },
  { id: "people", label: "People & Companies", stubPrefixes: ["server.context."] },
  { id: "documents", label: "Documents", stubPrefixes: ["server.context.doc", "server.artifacts."] },
  { id: "reports", label: "Reports", stubPrefixes: ["server.skills.", "server.delivery."] },
  { id: "connections", label: "Connections", stubPrefixes: ["server.connections.", "server.custody."] },
  { id: "systems", label: "Systems", stubPrefixes: ["server.sor."] },
  { id: "compliance", label: "Compliance", stubPrefixes: ["server.sentinel."] },
  { id: "workbench", label: "Workbench", stubPrefixes: ["workbench."] },
  { id: "stubs", label: "What's real yet", stubPrefixes: [] },
] as const;

export const DEFAULT_SECTION_ID = "home";

const SECTION_IDS = new Set(SECTIONS.map((s) => s.id));

/**
 * Parse a location.hash value into a known section id.
 * Accepts "#/inbox", "#inbox", "#/inbox/anything?x=1" (first segment wins);
 * unknown or empty hashes fall back to the home section.
 */
export function parseRoute(hash: string): string {
  const cleaned = hash.replace(/^#/, "").replace(/^\/+/, "");
  const first = cleaned.split(/[/?]/)[0] ?? "";
  const candidate = first.trim().toLowerCase();
  return SECTION_IDS.has(candidate) ? candidate : DEFAULT_SECTION_ID;
}

/** Look up a section by id (falls back to home). */
export function sectionFor(id: string): Section {
  const found = SECTIONS.find((s) => s.id === id) ?? SECTIONS[0];
  if (!found) throw new Error("portal: SECTIONS must not be empty");
  return found;
}
