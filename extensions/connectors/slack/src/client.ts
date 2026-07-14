import { z } from "zod";

/**
 * Minimal fetch-based Slack Web API client — no @slack/web-api, no
 * dependencies beyond zod (already a workspace dep). The fetch and sleep
 * functions are injectable so tests replay recorded fixtures and rate-limit
 * scenarios deterministically; production uses the Bun globals.
 *
 * Rate limiting follows Slack's contract: HTTP 429 with a `Retry-After`
 * header (seconds). The client sleeps and retries up to
 * `maxRateLimitRetries` times, then throws SlackRateLimitError.
 */

export const SLACK_API_BASE_URL = "https://slack.com/api";
export const DEFAULT_MAX_RATE_LIMIT_RETRIES = 3;

/** Slack answered HTTP 200 but `ok: false` — carries the Slack error code. */
export class SlackApiError extends Error {
  readonly method: string;
  readonly code: string;

  constructor(method: string, code: string, needed?: string) {
    super(`slack ${method}: ${code}${needed !== undefined ? ` (needs scope ${needed})` : ""}`);
    this.name = "SlackApiError";
    this.method = method;
    this.code = code;
  }
}

/** Non-2xx, non-429 HTTP response from the Slack API host. */
export class SlackHttpError extends Error {
  readonly method: string;
  readonly status: number;

  constructor(method: string, status: number) {
    super(`slack ${method}: HTTP ${status}`);
    this.name = "SlackHttpError";
    this.method = method;
    this.status = status;
  }
}

/** Still rate-limited after exhausting Retry-After-driven retries. */
export class SlackRateLimitError extends Error {
  readonly method: string;
  readonly retryAfterSeconds: number;

  constructor(method: string, retryAfterSeconds: number, attempts: number) {
    super(
      `slack ${method}: rate limited after ${attempts} attempt(s) (last Retry-After: ${retryAfterSeconds}s)`,
    );
    this.name = "SlackRateLimitError";
    this.method = method;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// ── response schemas (loose: Slack adds fields freely) ─────────────────────

export const slackChannelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    is_member: z.boolean().optional(),
    is_archived: z.boolean().optional(),
    is_private: z.boolean().optional(),
  })
  .passthrough();
export type SlackChannel = z.infer<typeof slackChannelSchema>;

export const slackMessageSchema = z
  .object({
    type: z.string(),
    ts: z.string().min(1),
    text: z.string().optional(),
    user: z.string().optional(),
    bot_id: z.string().optional(),
    subtype: z.string().optional(),
    thread_ts: z.string().optional(),
    team: z.string().optional(),
    reply_count: z.number().int().optional(),
  })
  .passthrough();
export type SlackMessage = z.infer<typeof slackMessageSchema>;

const responseMetadataSchema = z.object({ next_cursor: z.string().optional() }).passthrough();

const conversationsListResponseSchema = z
  .object({
    channels: z.array(slackChannelSchema),
    response_metadata: responseMetadataSchema.optional(),
  })
  .passthrough();
export type ConversationsListResponse = z.infer<typeof conversationsListResponseSchema>;

const conversationsHistoryResponseSchema = z
  .object({
    messages: z.array(slackMessageSchema),
    has_more: z.boolean().optional(),
    response_metadata: responseMetadataSchema.optional(),
  })
  .passthrough();
export type ConversationsHistoryResponse = z.infer<typeof conversationsHistoryResponseSchema>;

const usersInfoResponseSchema = z
  .object({
    user: z
      .object({
        id: z.string().min(1),
        name: z.string().optional(),
        real_name: z.string().optional(),
        profile: z
          .object({ display_name: z.string().optional(), real_name: z.string().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type UsersInfoResponse = z.infer<typeof usersInfoResponseSchema>;

const authTestResponseSchema = z
  .object({
    url: z.string().optional(),
    team: z.string().optional(),
    user: z.string().optional(),
    team_id: z.string().optional(),
    user_id: z.string().optional(),
    bot_id: z.string().optional(),
  })
  .passthrough();
export type AuthTestResponse = z.infer<typeof authTestResponseSchema>;

const chatPostMessageResponseSchema = z
  .object({ channel: z.string(), ts: z.string() })
  .passthrough();
export type ChatPostMessageResponse = z.infer<typeof chatPostMessageResponseSchema>;

// ── client ──────────────────────────────────────────────────────────────────

/** Injectable transport knobs — everything except the token. */
export interface SlackTransportOptions {
  fetch?: typeof globalThis.fetch;
  /** Awaited before a rate-limit retry; injectable so tests don't wall-clock. */
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  maxRateLimitRetries?: number;
}

export interface SlackClientOptions extends SlackTransportOptions {
  token: string;
}

export interface ConversationsListParams {
  types?: string;
  cursor?: string;
  limit?: number;
  exclude_archived?: boolean;
}

export interface ConversationsHistoryParams {
  channel: string;
  /** Exclusive lower bound ts (Slack default inclusive=false). */
  oldest?: string;
  cursor?: string;
  limit?: number;
}

export interface ChatPostMessageParams {
  channel: string;
  text?: string | undefined;
  blocks?: unknown[] | undefined;
  thread_ts?: string | undefined;
}

export interface SlackClient {
  authTest(): Promise<AuthTestResponse>;
  conversationsList(params?: ConversationsListParams): Promise<ConversationsListResponse>;
  conversationsHistory(params: ConversationsHistoryParams): Promise<ConversationsHistoryResponse>;
  usersInfo(userId: string): Promise<UsersInfoResponse>;
  chatPostMessage(params: ChatPostMessageParams): Promise<ChatPostMessageResponse>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ParamValue = string | number | boolean | undefined;

export function createSlackClient(options: SlackClientOptions): SlackClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const baseUrl = options.baseUrl ?? SLACK_API_BASE_URL;
  const maxRetries = options.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;

  async function call<T>(
    method: string,
    params: Record<string, unknown>,
    schema: z.ZodType<T>,
    opts: { post?: boolean } = {},
  ): Promise<T> {
    let lastRetryAfter = 0;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      if (opts.post === true) {
        response = await doFetch(`${baseUrl}/${method}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.token}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(params),
        });
      } else {
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(params as Record<string, ParamValue>)) {
          if (value !== undefined) search.set(key, String(value));
        }
        const qs = search.toString();
        response = await doFetch(`${baseUrl}/${method}${qs === "" ? "" : `?${qs}`}`, {
          headers: { authorization: `Bearer ${options.token}` },
        });
      }

      if (response.status === 429) {
        const header = response.headers.get("retry-after");
        const parsed = header === null ? Number.NaN : Number.parseInt(header, 10);
        lastRetryAfter = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
        if (attempt >= maxRetries) {
          throw new SlackRateLimitError(method, lastRetryAfter, attempt + 1);
        }
        await sleep(lastRetryAfter * 1000);
        continue;
      }
      if (!response.ok) throw new SlackHttpError(method, response.status);

      const json = (await response.json()) as { ok?: boolean; error?: string; needed?: string };
      if (json.ok !== true) {
        throw new SlackApiError(method, json.error ?? "unknown_error", json.needed);
      }
      return schema.parse(json);
    }
  }

  return {
    authTest: () => call("auth.test", {}, authTestResponseSchema, { post: true }),
    conversationsList: (params = {}) =>
      call("conversations.list", { ...params }, conversationsListResponseSchema),
    conversationsHistory: (params) =>
      call("conversations.history", { ...params }, conversationsHistoryResponseSchema),
    usersInfo: (userId) => call("users.info", { user: userId }, usersInfoResponseSchema),
    chatPostMessage: (params) =>
      call("chat.postMessage", { ...params }, chatPostMessageResponseSchema, { post: true }),
  };
}

/** Walk conversations.list next_cursor pages to the end. */
export async function listAllChannels(
  client: SlackClient,
  params: Omit<ConversationsListParams, "cursor"> = {},
): Promise<SlackChannel[]> {
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.conversationsList({ ...params, ...(cursor !== undefined ? { cursor } : {}) });
    channels.push(...page.channels);
    const next = page.response_metadata?.next_cursor;
    cursor = next !== undefined && next !== "" ? next : undefined;
  } while (cursor !== undefined);
  return channels;
}
