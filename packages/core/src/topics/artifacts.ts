import { z } from "zod";
import { defineEventType } from "../events";

export const T_ARTIFACT_TEMPLATE_CREATED = defineEventType({
  topic: "artifact.template.created",
  description: "A render template version was registered (usable only once its gate is approved).",
  payload: z.object({
    slug: z.string().min(1),
    version: z.string().min(1),
    kind: z.string().min(1),
    bodyChecksum: z.string().min(1),
  }),
});
export const T_ARTIFACT_TEMPLATE_CHANGE_PROPOSED = defineEventType({
  topic: "artifact.template.change_proposed",
  description:
    "A template create/change opened its HumanRequest{template_change} gate; the version is unusable until approved.",
  payload: z.object({
    slug: z.string().min(1),
    version: z.string().min(1),
    priorVersion: z.string().optional(),
    humanRequestId: z.string().min(1),
  }),
});
export const T_ARTIFACT_RENDERED = defineEventType({
  topic: "artifact.rendered",
  description: "A template rendered an artifact draft.",
  payload: z.object({ templateSlug: z.string() }),
});
export const T_ARTIFACT_VERIFIED = defineEventType({
  topic: "artifact.verified",
  description: "Artifact verification ran; result is an evidence record.",
  payload: z.object({ passed: z.boolean() }),
});
