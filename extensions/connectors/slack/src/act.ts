import { z } from "zod";
import type { ActionReceipt, ConnectorAction } from "@lithis/sdk/connectors";
import { SlackApiError } from "./client";
import type { SlackClient } from "./client";

/**
 * The chat.write action — how anything leaves the building via Slack:
 * evidence cards, digests, nudges, thread replies. Params are zod-validated
 * before any network call; a Slack-side rejection (bad channel, missing
 * scope) returns an honest ok:false receipt rather than throwing, so the
 * ActionIntent gets a receipt either way.
 */

export const CHAT_WRITE_ACTION_KEY = "chat.write";

export const chatWriteParamsSchema = z
  .object({
    channel: z.string().min(1),
    text: z.string().min(1).optional(),
    /** Block Kit payload; validated by Slack, opaque here. */
    blocks: z.array(z.unknown()).nonempty().optional(),
    thread_ts: z.string().min(1).optional(),
  })
  .refine((p) => p.text !== undefined || p.blocks !== undefined, {
    message: "chat.write requires text and/or blocks",
  });
export type ChatWriteParams = z.infer<typeof chatWriteParamsSchema>;

export async function performChatWrite(
  client: SlackClient,
  action: ConnectorAction,
): Promise<ActionReceipt> {
  if (action.key !== CHAT_WRITE_ACTION_KEY) {
    throw new Error(`slack connector has no action '${action.key}' (intent ${action.intentId})`);
  }
  const params = chatWriteParamsSchema.parse(action.params);
  try {
    const posted = await client.chatPostMessage(params);
    return {
      ok: true,
      externalId: `${posted.channel}:${posted.ts}`,
      detail: `posted to ${posted.channel} (intent ${action.intentId})`,
    };
  } catch (err) {
    if (err instanceof SlackApiError) {
      return { ok: false, detail: `${err.message} (intent ${action.intentId})` };
    }
    throw err;
  }
}
