import { refToString } from "@lithis/core";
import type { HumanRequest, Ulid } from "@lithis/core";

/**
 * Pure Block Kit rendering for the Slack channel: evidence-first cards for
 * HumanRequests, digests, and follow-up nudges. No I/O — everything here is
 * unit-testable against fixture requests. The reply-resolve vocabulary the
 * cards advertise is the one ./inbound.ts parses; keep them in lockstep.
 */

/** One Slack Block Kit block — validated by Slack, opaque to the server. */
export type SlackBlock = Record<string, unknown>;

export interface SlackCardBody {
  /** Notification fallback / accessibility text. */
  text: string;
  blocks: SlackBlock[];
}

const KIND_HEADINGS: Record<HumanRequest["kind"], string> = {
  approval: "Approval requested",
  question: "Question for you",
  notification: "Heads up",
};

/** What a human types in the thread to resolve each kind of request. */
export function replyInstructions(kind: HumanRequest["kind"]): string {
  switch (kind) {
    case "approval":
      return "Reply in this thread with *approve* or *deny* (add a comment after the verdict).";
    case "question":
      return "Reply in this thread with *answer:* followed by your answer, or with one of the options.";
    case "notification":
      return "Reply in this thread with *ack* to acknowledge.";
  }
}

function mrkdwn(text: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function context(text: string): SlackBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

/** The evidence-first card for one HumanRequest. */
export function renderHumanRequestCard(request: HumanRequest): SlackCardBody {
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: KIND_HEADINGS[request.kind], emoji: true },
    },
    mrkdwn(request.summary),
  ];
  if (request.options !== undefined && request.options.length > 0) {
    blocks.push(mrkdwn(request.options.map((o) => `• \`${o}\``).join("\n")));
  }
  const evidence =
    request.evidenceIds.length === 0
      ? "no attached evidence"
      : `evidence: ${request.evidenceIds.map((id) => `\`${id}\``).join(", ")}`;
  blocks.push(
    context(
      `subject: \`${refToString(request.subjectRef)}\` · ${evidence} · request \`${request.id}\``,
    ),
  );
  blocks.push({ type: "divider" });
  blocks.push(context(replyInstructions(request.kind)));
  return { text: request.summary, blocks };
}

/** A digest listing pending requests (used by skills/weekly reports later). */
export function renderDigest(title: string, humanRequestIds: Ulid[]): SlackCardBody {
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: title, emoji: true } },
    mrkdwn(
      humanRequestIds.length === 0
        ? "Nothing pending. 🎉"
        : humanRequestIds.map((id) => `• request \`${id}\``).join("\n"),
    ),
    context(`${humanRequestIds.length} pending request(s)`),
  ];
  return { text: title, blocks };
}

/** A follow-up nudge, posted into the original card's thread. */
export function renderNudge(request: HumanRequest, followUpCount: number): SlackCardBody {
  const nth =
    followUpCount === 1
      ? "1st"
      : followUpCount === 2
        ? "2nd"
        : followUpCount === 3
          ? "3rd"
          : `${followUpCount}th`;
  const text = `:bell: ${nth} follow-up — still waiting on this ${request.kind}.`;
  return {
    text,
    blocks: [mrkdwn(text), context(replyInstructions(request.kind))],
  };
}

// ── the "channel:ts" anchor codec (matches the slack connector's externalId) ─

export function encodeAnchor(channel: string, ts: string): string {
  return `${channel}:${ts}`;
}

export function decodeAnchor(externalId: string): { channel: string; ts: string } | undefined {
  const sep = externalId.indexOf(":");
  if (sep <= 0 || sep === externalId.length - 1) return undefined;
  return { channel: externalId.slice(0, sep), ts: externalId.slice(sep + 1) };
}
