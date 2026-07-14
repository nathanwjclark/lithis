import type { Connection } from "@lithis/core";
import type { IngestSink } from "@lithis/sdk/connectors";
import { listAllChannels, SlackApiError } from "./client";
import type { SlackClient, SlackMessage } from "./client";
import {
  decodeCursor,
  encodeCursor,
  normalizeMessage,
  shouldIngestMessage,
  tsGreaterThan,
} from "./normalize";

/**
 * channel-messages feed sync: pull new messages from every channel the bot
 * is a member of, from each channel's durable ts watermark forward, and land
 * them through the IngestSink as raw-JSON blobs + typed message docs.
 * Idempotent: watermarks only advance past what was actually ingested, and
 * Slack's `oldest` bound is exclusive, so a re-run from the returned cursor
 * ingests nothing new.
 */

export const CHANNEL_MESSAGES_FEED_KEY = "channel-messages";
const HISTORY_PAGE_LIMIT = 200;
/** Public + private channels; IMs/MPIMs are out of scope for this feed. */
const CHANNEL_TYPES = "public_channel,private_channel";

/** users.info resolver with a per-sync cache; unknown users degrade to undefined. */
async function resolveAuthorName(
  client: SlackClient,
  cache: Map<string, string | undefined>,
  userId: string,
): Promise<string | undefined> {
  if (cache.has(userId)) return cache.get(userId);
  let name: string | undefined;
  try {
    const { user } = await client.usersInfo(userId);
    name =
      user.profile?.display_name !== undefined && user.profile.display_name !== ""
        ? user.profile.display_name
        : (user.real_name ?? user.name);
  } catch (err) {
    // A deleted/external user must not fail the whole sync; the doc keeps the raw id.
    if (!(err instanceof SlackApiError && err.code === "user_not_found")) throw err;
  }
  cache.set(userId, name);
  return name;
}

export async function syncChannelMessages(
  client: SlackClient,
  connection: Connection,
  cursor: string | null,
  sink: IngestSink,
): Promise<string> {
  const state = decodeCursor(cursor);
  const next = { v: 1 as const, channels: { ...state.channels } };
  const userNames = new Map<string, string | undefined>();

  const channels = (await listAllChannels(client, { types: CHANNEL_TYPES })).filter(
    (channel) => channel.is_member === true && channel.is_archived !== true,
  );

  for (const channel of channels) {
    const watermark = state.channels[channel.id];
    let newest = watermark;
    let pageCursor: string | undefined;

    do {
      const page = await client.conversationsHistory({
        channel: channel.id,
        limit: HISTORY_PAGE_LIMIT,
        ...(watermark !== undefined ? { oldest: watermark } : {}),
        ...(pageCursor !== undefined ? { cursor: pageCursor } : {}),
      });

      // conversations.history returns newest-first; ingest oldest-first for
      // deterministic ordering within a page.
      const messages: SlackMessage[] = [...page.messages].sort((a, b) =>
        tsGreaterThan(a.ts, b.ts) ? 1 : -1,
      );
      for (const message of messages) {
        if (newest === undefined || tsGreaterThan(message.ts, newest)) newest = message.ts;
        if (!shouldIngestMessage(message)) continue;
        const authorName =
          message.user !== undefined
            ? await resolveAuthorName(client, userNames, message.user)
            : undefined;
        const normalized = normalizeMessage({
          connection,
          channel,
          message,
          ...(authorName !== undefined ? { authorName } : {}),
        });
        const blobRef = await sink.putBlob(normalized.blob);
        await sink.ingestDoc(normalized.docFor(blobRef.id));
      }

      const nextCursor = page.response_metadata?.next_cursor;
      pageCursor = nextCursor !== undefined && nextCursor !== "" ? nextCursor : undefined;
    } while (pageCursor !== undefined);

    if (newest !== undefined) next.channels[channel.id] = newest;
  }

  return encodeCursor(next);
}
