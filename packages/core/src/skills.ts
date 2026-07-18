import { z } from "zod";
import { capabilitySchema, recordBase, slugSchema } from "./common";
import { cronSchema, ulidSchema } from "./ids";
import { refSchema } from "./refs";

/**
 * Skills — git-authoritative definitions with a guarded self-modification
 * lifecycle: propose → evals → PR → approval → activate. The registry stores
 * checksum-bound git refs, never source. capabilityDiff (computed vs the prior
 * version) is the capability-creep check a human reviews.
 */

export const SKILL_KINDS = ["tool", "report", "workflow", "ui_capability"] as const;

export const skillSchema = z.object({
  ...recordBase,
  /** Null tenantId semantics (shared skills) modeled as an explicit flag instead. */
  shared: z.boolean().default(false),
  slug: slugSchema,
  kind: z.enum(SKILL_KINDS),
  currentVersionId: ulidSchema.optional(),
  status: z.enum(["active", "retired"]),
});
export type Skill = z.infer<typeof skillSchema>;

export const gitRefSchema = z.object({
  repo: z.string().min(1),
  ref: z.string().min(1),
  path: z.string().min(1),
});
export type GitRef = z.infer<typeof gitRefSchema>;

export const skillManifestSchema = z.object({
  description: z.string().min(1),
  /** JSON schema for the skill's input. */
  inputSchema: z.record(z.unknown()),
  capabilitiesRequired: z.array(capabilitySchema).default([]),
  triggers: z
    .object({
      schedule: cronSchema.optional(),
      onEvents: z.array(z.string()).optional(),
    })
    .optional(),
  /** Self-modification bounds: what an agent may touch when editing this skill. */
  selfModBounds: z.object({
    modifiablePaths: z.array(z.string()).default([]),
    forbidden: z.array(z.string()).default([]),
  }),
});
export type SkillManifest = z.infer<typeof skillManifestSchema>;

export const SKILL_VERSION_STATUSES = [
  "proposed",
  "approved",
  "active",
  "retired",
  "rejected",
] as const;

export const skillVersionSchema = z.object({
  ...recordBase,
  skillId: ulidSchema,
  semver: z.string().regex(/^\d+\.\d+\.\d+$/),
  sourceRef: gitRefSchema,
  /** Checksum of the source at approval — activation is bound to exactly this content. */
  checksum: z.string().min(1),
  manifest: skillManifestSchema,
  /** Computed vs prior version: capabilities added/removed — the creep check. */
  capabilityDiff: z.object({
    added: z.array(capabilitySchema).default([]),
    removed: z.array(capabilitySchema).default([]),
  }),
  /** Eval run that must pass before this version is approvable. */
  evalRunId: ulidSchema.optional(),
  approvalRequestId: ulidSchema.optional(),
  authoredBy: refSchema,
  status: z.enum(SKILL_VERSION_STATUSES),
});
export type SkillVersion = z.infer<typeof skillVersionSchema>;

/** Kept for the portal Reports tab; reporting itself is dissolved into skills + recurring WorkItems + delivery. */
export const reportDefinitionSchema = z.object({
  ...recordBase,
  slug: slugSchema,
  skillRef: refSchema,
  schedule: cronSchema,
  audience: z.array(
    z.object({
      channel: z.enum(["slack", "teams", "email", "portal"]),
      target: z.string().min(1),
    }),
  ),
  format: z.enum(["markdown", "html", "pdf"]).default("markdown"),
  approvalPolicy: z.enum(["none", "first_run", "every_run"]).default("first_run"),
});
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;
