import { z } from "zod";
import { defineEventType } from "../events";

export const T_SOR_MIGRATION_PROPOSED = defineEventType({
  topic: "sor.migration.proposed",
  description: "A system-of-record schema migration was proposed (approval-gated).",
  payload: z.object({ sorSlug: z.string(), version: z.number().int() }),
});
export const T_SOR_MIGRATION_APPLIED = defineEventType({
  topic: "sor.migration.applied",
  description: "An approved SoR migration was applied.",
  payload: z.object({ sorSlug: z.string(), version: z.number().int(), appliedBy: z.string() }),
});
