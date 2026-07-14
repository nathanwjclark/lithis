import { z } from "zod";
import { isoDateTimeSchema, ulidSchema } from "./ids";
import { refSchema } from "./refs";

/**
 * Origin — the ONE provenance shape, stamped on blobs, docs, entities, links,
 * artifacts, and generated SoR rows. Merges "who/how made this" with "how much
 * to trust its content". There is deliberately NO fact-grading here: context
 * stores information; review states live on WorkItem/HumanRequest only.
 */

export const ORIGIN_METHODS = ["code", "llm", "human", "external"] as const;
export const originMethodSchema = z.enum(ORIGIN_METHODS);
export type OriginMethod = z.infer<typeof originMethodSchema>;

export const TRUST_LEVELS = ["internal", "partner", "untrusted"] as const;
export const trustLevelSchema = z.enum(TRUST_LEVELS);
export type TrustLevel = z.infer<typeof trustLevelSchema>;

export const originSchema = z.object({
  /** Who produced this record: a principal (human/agent/service) or a connection. */
  by: refSchema.refine((r) => r.kind === "principal" || r.kind === "connection", {
    message: "origin.by must reference a principal or a connection",
  }),
  method: originMethodSchema,
  /** How much the CONTENT is trusted; untrusted/partner content is always DATA, never instructions. */
  trust: trustLevelSchema,
  /** The Session this was produced in, when agent/human work created it. */
  sessionId: ulidSchema.optional(),
  at: isoDateTimeSchema,
});
export type Origin = z.infer<typeof originSchema>;
