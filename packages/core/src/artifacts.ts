import { z } from "zod";
import { recordBase, slugSchema } from "./common";
import { ulidSchema } from "./ids";

/**
 * Artifacts — template-driven document/asset generation + verification.
 * Verification IS Evidence (an evidence record of kind 'verification');
 * template changes gate through the ONE human primitive.
 */

export const TEMPLATE_KINDS = ["document", "image", "video", "email", "report"] as const;

export const templateCheckSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("deterministic"), ref: z.string().min(1) }),
  z.object({ kind: z.literal("rubric"), prompt: z.string().min(1) }),
]);

export const templateSchema = z.object({
  ...recordBase,
  slug: slugSchema,
  version: z.string().min(1),
  kind: z.enum(TEMPLATE_KINDS),
  /** JSON schema for the template's fill-in fields. */
  fieldsSchema: z.record(z.unknown()),
  bodyBlobId: ulidSchema,
  checks: z.array(templateCheckSchema).default([]),
  approvalPolicy: z.enum(["none", "always"]).default("always"),
  approvalRequestId: ulidSchema.optional(),
});
export type Template = z.infer<typeof templateSchema>;

export const ARTIFACT_STATES = ["draft", "verified", "failed", "approved", "published"] as const;

export const artifactSchema = z.object({
  ...recordBase,
  templateRef: z.object({ id: ulidSchema, version: z.string() }),
  inputsJson: z.unknown(),
  outputBlobId: ulidSchema,
  verification: z
    .object({
      passed: z.boolean(),
      findings: z.array(z.string()).default([]),
      /** The evidence record documenting what was checked. */
      evidenceId: ulidSchema,
    })
    .optional(),
  state: z.enum(ARTIFACT_STATES),
  producedByRunId: ulidSchema.optional(),
});
export type Artifact = z.infer<typeof artifactSchema>;
