import { z } from "zod";
import { defineEventType } from "../events";

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
