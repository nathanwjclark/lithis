import { z } from "zod";
import { defineEventType } from "../events";

export const T_WORKSPACE_STATUS = defineEventType({
  topic: "workspace.status_changed",
  description: "Workbench workspace lifecycle transition (sentinel-visible).",
  payload: z.object({ from: z.string(), to: z.string() }),
});
