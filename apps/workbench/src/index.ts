import type { Ulid, Workspace } from "@lithis/core";
import { stubService } from "@lithis/stubkit";

/**
 * @lithis/workbench — cloud Claude Code environment (pillar 5).
 *
 * Per-tenant containers running Claude Code, exposed as a real web app.
 * Egress is PR-only; every lifecycle transition is a spine event
 * (workspace.status_changed) and all activity happens inside Sessions, so
 * sentinel watcher agents can see workbench work.
 */

/** A live attachment to a running workspace container (browser session URL). */
export interface WorkbenchAttachment {
  workspaceId: Ulid;
  /** Brokered URL the workbench UI connects to — never a raw container address. */
  url: string;
}

/**
 * The workbench container runtime. Typed against the Workspace record in
 * @lithis/core — this interface is the module boundary the server and portal
 * program against.
 */
export interface WorkbenchHost {
  /** Provision a new workspace container for a principal on a repo+branch. */
  provision(principalId: Ulid, repoRef: Workspace["repoRef"]): Promise<Workspace>;
  /** Attach to a running workspace (starting it from idle if needed). */
  attach(workspaceId: Ulid): Promise<WorkbenchAttachment>;
  /** Archive a workspace: container torn down, record kept for audit. */
  archive(workspaceId: Ulid): Promise<Workspace>;
  /** All workspaces for a tenant (the portal Workbench tab). */
  list(tenantId: Ulid): Promise<Workspace[]>;
}

/** Container runtime not implemented in the skeleton — every method throws. */
export function createWorkbenchHost(): WorkbenchHost {
  return stubService<WorkbenchHost>(
    "workbench.host",
    ["provision", "attach", "archive", "list"],
    "LITHIS-STUB: per-tenant workbench container runtime (provision/attach/archive/list with PR-only egress) not implemented — build-out phase 10",
  );
}
