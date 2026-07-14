import { z } from "zod";
import { recordBase } from "./common";
import { isoDateTimeSchema, ulidSchema } from "./ids";

/**
 * Workspace — a cloud dev-environment session (the workbench app): per-tenant
 * containers running Claude Code, reachable as a real web app. Egress is
 * PR-only; workspace actions are spine events, so watcher agents can see them.
 */

export const WORKSPACE_STATUSES = ["provisioning", "active", "idle", "archived"] as const;

export const workspaceSchema = z.object({
  ...recordBase,
  principalId: ulidSchema,
  /** The repo this workspace works on (URL + branch). */
  repoRef: z.object({ url: z.string().min(1), branch: z.string().min(1) }),
  containerRef: z.string().optional(),
  status: z.enum(WORKSPACE_STATUSES),
  egressPolicy: z.literal("pr_only"),
  lastActiveAt: isoDateTimeSchema.optional(),
});
export type Workspace = z.infer<typeof workspaceSchema>;
