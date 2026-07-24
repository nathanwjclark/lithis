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
export const T_SOR_ROW_WRITTEN = defineEventType({
  topic: "sor.row.written",
  description:
    "A row was written through a scoped SoR table handle (insert or update) — the provenance trail for generated-system data.",
  payload: z.object({
    sorSlug: z.string().min(1),
    table: z.string().min(1),
    op: z.enum(["insert", "update"]),
    rows: z.number().int().nonnegative(),
  }),
});
