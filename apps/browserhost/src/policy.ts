import { z } from "zod";

/**
 * Timing-only humanization policy — REAL config, zod-validated. This is the
 * whole humanization surface: pacing. No synthetic mouse curves, no
 * fingerprint spoofing, and `captcha` is a literal: pause + notify a human.
 */
export const humanizationPolicySchema = z
  .object({
    /** Minimum delay between actions, in milliseconds. */
    minDelayMs: z.number().int().nonnegative(),
    /** Uniform random jitter added on top of minDelayMs. */
    jitterMs: z.number().int().nonnegative(),
    /** Hard hourly cap on actions per mounted session. */
    maxActionsPerHour: z.number().int().positive(),
    /** [min, max] dwell time on a page before the next action, in milliseconds. */
    dwellMsRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
    /** The only supported CAPTCHA behavior — lithis never auto-solves. */
    captcha: z.literal("pause_and_notify"),
  })
  .refine((p) => p.dwellMsRange[0] <= p.dwellMsRange[1], {
    message: "dwellMsRange must be [min, max] with min <= max",
    path: ["dwellMsRange"],
  });
export type HumanizationPolicy = z.infer<typeof humanizationPolicySchema>;

/** Conservative shipped default: slow, bounded, human-paced. */
export const defaultHumanizationPolicy: HumanizationPolicy = humanizationPolicySchema.parse({
  minDelayMs: 1_200,
  jitterMs: 2_500,
  maxActionsPerHour: 40,
  dwellMsRange: [2_000, 15_000],
  captcha: "pause_and_notify",
});
