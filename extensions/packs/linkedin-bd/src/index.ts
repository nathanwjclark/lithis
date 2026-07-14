import type { AgentCharter, Slug } from "@lithis/core";
import { stubValue } from "@lithis/stubkit";

/**
 * @lithis/pack-linkedin-bd — Sales Navigator selector pack + the BD resident
 * agent charter. See README.md for the degree-guard rules.
 */

/**
 * CSS selectors for a Sales Navigator search-results card. The TYPE is real —
 * this is the contract the linkedin connector's sync scraper is written
 * against; the VALUES are a stub until the crm scraper migrates.
 */
export interface SalesNavCardSelectors {
  /** Prospect display name within a result card. */
  name: string;
  /** Current title line within a result card. */
  title: string;
  /** Current company link/text within a result card. */
  company: string;
  /** Mutual-connections count element ("12 shared connections"). */
  mutualCount: string;
  /** Anchor carrying the prospect's profile URL. */
  profileUrl: string;
  /** Next-page control for paginating search results. */
  pagination: string;
}

/**
 * Selector VALUES — loud stub: any property access throws until the real
 * selectors migrate from the private CRM scraper.
 */
export const salesNavCardSelectors: SalesNavCardSelectors = stubValue<SalesNavCardSelectors>(
  "packs.linkedin-bd.selectors",
  "LITHIS-STUB: selectors migrate from the crm scraper (crm/scraper/extract-cards.ts) when that service migrates",
);

/** Charter config shape shared with pack watcher configs: { slug, role, wake }. */
export interface BdAgentCharterConfig {
  slug: Slug;
  role: string;
  wake: AgentCharter["wake"];
}

/**
 * The BD resident agent — an openclaw-style daemon, not an invoked worker.
 * REAL charter data: installed as a Principal(kind 'agent') + AgentCharter.
 */
export const bdAgentCharterConfig: BdAgentCharterConfig = {
  slug: "linkedin-bd-agent",
  role: [
    "You are the LinkedIn business-development resident agent.",
    "Nightly, run the configured Sales Navigator sweeps through the linkedin connector and ingest new",
    "prospect cards and profiles — every person or company you create is degree 2, always, with full",
    "origin/session provenance. Degree-2 data never appears in network-audience answers; when you",
    "search, use the prospecting audience explicitly.",
    "Rank prospects by connection paths: RelationshipGraph.paths over the tenant's real network,",
    "weighted by relationship strength — a warm mutual beats a cold direct hit. From the ranked list,",
    "draft outreach (connection notes, messages) tailored to each prospect and propose it as ONE",
    "ActionIntent batch for human approval with per-item verdicts and your path evidence attached.",
    "NEVER contact anyone without an approved batch: no connects, no messages, no exceptions — denied",
    "items are dropped and their feedback recorded in your notebook for the next batch.",
    "Execute approved items through the linkedin connector under browserhost humanization pacing; if a",
    "CAPTCHA or session problem pauses the browser, stop and notify — never work around it.",
    "Track accepted connections as evidence for deliberate degree promotion, and keep your working",
    "memory (segments tried, reply rates, phrasing that lands) in your agent notebook.",
  ].join(" "),
  wake: {
    // Nightly sweep at 02:30 tenant-local; batch resolutions and replies wake it too.
    heartbeat: "30 2 * * *",
    onEvents: ["humangate.resolved", "conversation.message"],
    onMessages: true,
  },
};
