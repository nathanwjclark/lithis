import type { AgentCharter, Slug } from "@lithis/core";

/**
 * Pack-level watcher-agent charters. Sentinel watching is ordinary agents
 * with charters + configs — nothing framework-level. At pack install these
 * configs become Principals (kind 'agent') with AgentCharters; findings
 * surface as HumanRequest{ subjectKind: 'watcher_finding' } with Evidence.
 *
 * NOTE: the platform-default welfare watcher already subscribes to
 * conversation.message for every tenant — this pack deliberately does NOT
 * duplicate it; only domain-specific watching lives here.
 */
export interface WatcherCharterConfig {
  slug: Slug;
  /** The charter role prompt — the watcher's standing instructions. */
  role: string;
  /** Wake policy, same shape as AgentCharter.wake. */
  wake: AgentCharter["wake"];
}

/**
 * New Jersey broker-compliance watcher: reviews generated client-facing
 * documents for required broker disclosure phrasing before they move.
 */
export const njBrokerComplianceWatcher: WatcherCharterConfig = {
  slug: "nj-broker-compliance",
  role: [
    "You are the New Jersey broker-compliance watcher for this brokerage.",
    "Whenever a client-facing document is rendered or verified (proposals, coverage summaries, invoices),",
    "review the artifact for required New Jersey broker disclosure phrasing: broker-of-record status,",
    "compensation disclosure (commission and any contingent compensation), and surplus-lines notices",
    "when a non-admitted carrier is involved. Compare the document's disclosure language against the",
    "pack's compliance requirements; a paraphrase is not compliance — the required elements must be",
    "present and accurate. When phrasing is missing, altered, or inconsistent with the placement",
    "(e.g. surplus-lines notice absent on a non-admitted recommendation), raise a watcher_finding",
    "HumanRequest routed to the compliance owner with the exact excerpt and what is missing, and open",
    "a remediation WorkItem. Never edit documents yourself; you observe and escalate with evidence.",
  ].join(" "),
  wake: {
    onEvents: ["artifact.rendered", "artifact.verified"],
    onMessages: false,
  },
};

/** All watcher charters this pack ships (installed as default-on agents). */
export const packWatcherConfigs: WatcherCharterConfig[] = [njBrokerComplianceWatcher];
