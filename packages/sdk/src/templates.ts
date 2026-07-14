import type { z } from "zod";
import { templateSchema } from "@lithis/core";

/**
 * Template authoring kit. A TemplateSpec is what an author writes: the core
 * Template record minus server-assigned fields (record ids/timestamps, the
 * bodyBlobId minted at upload, and the approvalRequestId minted by humangate
 * when the change gates).
 */

export const templateSpecSchema = templateSchema.omit({
  id: true,
  tenantId: true,
  createdAt: true,
  updatedAt: true,
  bodyBlobId: true,
  approvalRequestId: true,
});
export type TemplateSpec = z.infer<typeof templateSpecSchema>;
export type TemplateSpecInput = z.input<typeof templateSpecSchema>;

/** Validate + normalize a template authoring spec. Throws ZodError on invalid input. */
export function defineTemplateSpec(data: TemplateSpecInput): TemplateSpec {
  return templateSpecSchema.parse(data);
}
