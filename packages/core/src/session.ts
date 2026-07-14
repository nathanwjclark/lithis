import { z } from "zod";
import { costSchema, recordBase } from "./common";
import { isoDateTimeSchema, ulidSchema } from "./ids";
import { refSchema } from "./refs";

/**
 * Session — first-class provenance for ALL agent/human activity. Every agent
 * wake, chat thread, executor run, and workbench stint happens inside a
 * Session; anything created carries origin.sessionId pointing back here.
 */

export const SESSION_KINDS = ["loop", "chat", "run", "workbench"] as const;

export const sessionSchema = z.object({
  ...recordBase,
  principalId: ulidSchema,
  kind: z.enum(SESSION_KINDS),
  /** Where the conversation lives, when there is one (slack thread, portal chat...). */
  channelRef: refSchema.optional(),
  transcriptBlobId: ulidSchema.optional(),
  startedAt: isoDateTimeSchema,
  endedAt: isoDateTimeSchema.optional(),
  summary: z.string().optional(),
  cost: costSchema,
});
export type Session = z.infer<typeof sessionSchema>;
