import type { Connection, Origin } from "@lithis/core";
import type { NewBlobInput, NewDocInput } from "@lithis/sdk/connectors";
import type { SlackChannel, SlackMessage } from "./client";

/**
 * Pure normalization: Slack API message JSON → typed doc/blob inputs for the
 * IngestSink, plus the durable cursor codec for the channel-messages feed.
 * No I/O here — everything is unit-testable against fixtures.
 */

// ── cursor codec ────────────────────────────────────────────────────────────

/**
 * Durable cursor for the channel-messages feed: newest INGESTED message ts
 * per channel. Serialized as versioned JSON in Connection.syncState
 * (cursors are opaque strings to the server). Slack's `oldest` param is
 * exclusive by default, so re-syncing from a watermark never re-reads it.
 */
export interface ChannelMessagesCursor {
  v: 1;
  channels: Record<string, string>;
}

export function decodeCursor(cursor: string | null): ChannelMessagesCursor {
  if (cursor === null || cursor === "") return { v: 1, channels: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    throw new Error(`slack channel-messages cursor is not valid JSON: ${cursor}`);
  }
  const candidate = parsed as { v?: unknown; channels?: unknown };
  if (candidate?.v !== 1 || typeof candidate.channels !== "object" || candidate.channels === null) {
    throw new Error(`slack channel-messages cursor has unknown shape/version: ${cursor}`);
  }
  const channels: Record<string, string> = {};
  for (const [key, value] of Object.entries(candidate.channels as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new Error(`slack channel-messages cursor: non-string watermark for ${key}`);
    }
    channels[key] = value;
  }
  return { v: 1, channels };
}

export function encodeCursor(cursor: ChannelMessagesCursor): string {
  const channels: Record<string, string> = {};
  for (const key of Object.keys(cursor.channels).sort()) {
    channels[key] = cursor.channels[key]!;
  }
  return JSON.stringify({ v: 1, channels });
}

/** Slack ts strings ("1718000000.000100") compare numerically per segment. */
export function tsGreaterThan(a: string, b: string): boolean {
  const [aSec = "0", aSeq = "0"] = a.split(".");
  const [bSec = "0", bSeq = "0"] = b.split(".");
  if (Number(aSec) !== Number(bSec)) return Number(aSec) > Number(bSec);
  return Number(aSeq) > Number(bSeq);
}

// ── message → doc/blob inputs ───────────────────────────────────────────────

/**
 * Message subtypes that carry conversational content worth ingesting; the
 * rest (channel_join, channel_topic, ...) are room noise. Plain user
 * messages have NO subtype and are always ingested.
 */
export const INGESTED_SUBTYPES: ReadonlySet<string> = new Set([
  "bot_message",
  "thread_broadcast",
  "file_share",
  "me_message",
]);

export function shouldIngestMessage(message: SlackMessage): boolean {
  if (message.type !== "message") return false;
  if (message.subtype === undefined) return true;
  return INGESTED_SUBTYPES.has(message.subtype);
}

export function slackTsToIso(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) throw new Error(`invalid slack ts: ${ts}`);
  return new Date(seconds * 1000).toISOString();
}

/** e.g. C0100AL5K9 + 1718000000.000100 → "slack-msg-c0100al5k9-1718000000-000100". */
export function messageSlug(channelId: string, ts: string): string {
  return `slack-msg-${channelId.toLowerCase()}-${ts.replace(".", "-")}`;
}

function messageOrigin(connection: Connection, message: SlackMessage): Origin {
  return {
    by: { kind: "connection", id: connection.id },
    method: "external",
    // Workspace members' own comms: internal content (still quarantined at ingest).
    trust: "internal",
    at: slackTsToIso(message.ts),
  };
}

const TITLE_SNIPPET_LENGTH = 80;

export function messageTitle(
  channel: SlackChannel,
  message: SlackMessage,
  authorName: string | undefined,
): string {
  const author = authorName ?? message.user ?? message.bot_id ?? "unknown";
  const flattened = (message.text ?? "").replace(/\s+/g, " ").trim();
  const snippet =
    flattened.length > TITLE_SNIPPET_LENGTH
      ? `${flattened.slice(0, TITLE_SNIPPET_LENGTH - 1)}…`
      : flattened;
  const base = `#${channel.name} — ${author}`;
  return snippet === "" ? `${base} (message ${message.ts})` : `${base}: ${snippet}`;
}

export interface NormalizedMessage {
  /** Raw Slack message JSON, ingested verbatim as the doc body blob. */
  blob: NewBlobInput;
  /** Build the doc input once the blob ref is known. */
  docFor(bodyBlobId: string): NewDocInput;
}

export function normalizeMessage(input: {
  connection: Connection;
  channel: SlackChannel;
  message: SlackMessage;
  /** Resolved human-readable author (users.info), when there is one. */
  authorName?: string;
}): NormalizedMessage {
  const { connection, channel, message, authorName } = input;
  const origin = messageOrigin(connection, message);
  return {
    blob: {
      bytes: new TextEncoder().encode(JSON.stringify(message)),
      mediaType: "application/json",
      origin,
    },
    docFor: (bodyBlobId: string): NewDocInput => ({
      type: "message",
      slug: messageSlug(channel.id, message.ts),
      title: messageTitle(channel, message, authorName),
      bodyBlobId,
      frontmatter: {
        source: "slack",
        channelId: channel.id,
        channelName: channel.name,
        ts: message.ts,
        ...(message.thread_ts !== undefined ? { threadTs: message.thread_ts } : {}),
        ...(message.user !== undefined ? { userId: message.user } : {}),
        ...(authorName !== undefined ? { userName: authorName } : {}),
        ...(message.bot_id !== undefined ? { botId: message.bot_id } : {}),
        ...(message.subtype !== undefined ? { subtype: message.subtype } : {}),
        ...(message.team !== undefined ? { team: message.team } : {}),
      },
      origin,
    }),
  };
}
