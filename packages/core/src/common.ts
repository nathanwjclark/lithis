import { z } from "zod";
import { isoDateTimeSchema, ulidSchema } from "./ids";

/** Fields every persisted record carries. */
export const recordBase = {
  id: ulidSchema,
  tenantId: ulidSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
} as const;

/** Mutable records additionally carry a revision counter (bumped on every update). */
export const revisioned = {
  ...recordBase,
  revision: z.number().int().nonnegative(),
} as const;

export const jsonValueSchema: z.ZodType<unknown> = z.unknown();

/** Model/run cost accounting shape. */
export const costSchema = z.object({
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
});
export type Cost = z.infer<typeof costSchema>;

/** Short machine-friendly slug. */
export const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "lowercase slug (a-z0-9, - or _ separators)");
export type Slug = z.infer<typeof slugSchema>;

/** Dot-namespaced capability string, e.g. "gmail.send", "browser.linkedin.connect". */
export const capabilitySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, "dot-namespaced capability");
export type Capability = z.infer<typeof capabilitySchema>;
