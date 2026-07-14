import { newUlid, nowIso } from "@lithis/core";

/** Fixture server-assigned fields — drafts + these = full records. */
export function serverFields() {
  const at = nowIso();
  return {
    id: newUlid(),
    tenantId: newUlid(),
    createdAt: at,
    updatedAt: at,
  };
}
