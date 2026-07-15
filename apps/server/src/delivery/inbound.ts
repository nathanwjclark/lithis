import { z } from "zod";
import type { HumanRequest, HumanResolution } from "@lithis/core";

/**
 * Inbound Slack message handling — pure pieces only (schemas + the
 * reply→verdict vocabulary). The I/O side (doc ingest, conversation.message
 * emission, humanGate.resolve) lives in ./service.ts; the Socket Mode / HTTP
 * transports both funnel into it through these schemas.
 *
 * Vocabulary contract: whatever ./render.ts advertises on the cards must
 * parse here — approve/deny for approvals, "answer: ..." (or an option match)
 * for questions, ack for notifications.
 */

// ── Slack event payload schemas (Events API / Socket Mode both carry these) ─

/** The inner `event` object of a Slack message event. Loose — Slack adds fields freely. */
export const slackMessageEventSchema = z
  .object({
    type: z.string(),
    channel: z.string().min(1),
    ts: z.string().min(1),
    text: z.string().optional(),
    user: z.string().optional(),
    bot_id: z.string().optional(),
    subtype: z.string().optional(),
    thread_ts: z.string().optional(),
    team: z.string().optional(),
  })
  .passthrough();
export type SlackMessageEvent = z.infer<typeof slackMessageEventSchema>;

/** Events-API outer envelope (`event_callback`) or a bare inner event. */
export const slackEventEnvelopeSchema = z.union([
  z
    .object({
      type: z.literal("event_callback"),
      event: slackMessageEventSchema,
      team_id: z.string().optional(),
    })
    .passthrough(),
  slackMessageEventSchema,
]);

/** Unwrap an Events-API envelope (or pass a bare event through). */
export function unwrapSlackEvent(payload: unknown): SlackMessageEvent | undefined {
  const parsed = slackEventEnvelopeSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  return "event" in value ? (value as { event: SlackMessageEvent }).event : value;
}

/**
 * Inbound ingestion policy: plain human messages only. Bot messages are
 * skipped for loop safety (our own cards/nudges are bot posts), and subtyped
 * room noise (channel_join, message_changed, ...) is not a conversation turn.
 */
export function shouldIngestInbound(event: SlackMessageEvent): boolean {
  if (event.type !== "message") return false;
  if (event.bot_id !== undefined) return false;
  if (event.subtype !== undefined && event.subtype !== "thread_broadcast") return false;
  return (event.text ?? "").trim() !== "";
}

// ── reply → verdict vocabulary ───────────────────────────────────────────────

const APPROVE_WORDS = new Set(["approve", "approved", "yes", "lgtm", "ok", "okay", "👍"]);
const DENY_WORDS = new Set(["deny", "denied", "reject", "rejected", "no"]);
const ACK_WORDS = new Set(["ack", "acked", "acknowledge", "acknowledged"]);
const ANSWER_PREFIX = /^answer\s*[:\-–]?\s*/i;

export interface ParsedReply {
  verdict: HumanResolution["verdict"];
  /** What lands in resolution.comment (always present per the schema). */
  comment: string;
}

function firstToken(text: string): string {
  return (text.trim().split(/\s+/)[0] ?? "").replace(/[!.,;:]+$/, "").toLowerCase();
}

/**
 * Map a thread reply to a resolution verdict for the given request. Returns
 * undefined for chatter that is not a recognizable verdict — an unparsed
 * reply NEVER resolves anything.
 */
export function parseReplyVerdict(
  request: Pick<HumanRequest, "kind" | "options">,
  text: string,
): ParsedReply | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const token = firstToken(trimmed);

  switch (request.kind) {
    case "approval": {
      if (APPROVE_WORDS.has(token)) return { verdict: "approved", comment: trimmed };
      if (DENY_WORDS.has(token)) return { verdict: "denied", comment: trimmed };
      return undefined;
    }
    case "question": {
      const explicit = trimmed.match(ANSWER_PREFIX);
      if (explicit !== null) {
        const answer = trimmed.slice(explicit[0].length).trim();
        return answer === "" ? undefined : { verdict: "answered", comment: answer };
      }
      const option = (request.options ?? []).find(
        (o) => o.toLowerCase() === trimmed.toLowerCase(),
      );
      if (option !== undefined) return { verdict: "answered", comment: option };
      return undefined;
    }
    case "notification": {
      if (ACK_WORDS.has(token)) return { verdict: "acknowledged", comment: trimmed };
      return undefined;
    }
  }
}
