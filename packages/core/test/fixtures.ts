/**
 * Shared test fixtures — the ONE place mock data belongs. Every fixture is a
 * plausible, fully-valid record used by round-trip tests.
 */

import type { Origin } from "@lithis/core";
import { newUlid, nowIso } from "@lithis/core";

export const ids = {
  tenant: newUlid(),
  humanPrincipal: newUlid(),
  agentPrincipal: newUlid(),
  session: newUlid(),
  blob: newUlid(),
  doc: newUlid(),
  entityPerson: newUlid(),
  entityCompany: newUlid(),
  workItem: newUlid(),
  processRun: newUlid(),
  run: newUlid(),
  runResult: newUlid(),
  evidence: newUlid(),
  humanRequest: newUlid(),
  connection: newUlid(),
  credential: newUlid(),
  skill: newUlid(),
  skillVersion: newUlid(),
  template: newUlid(),
  memoryBlob: newUlid(),
} as const;

export function baseRecord(id: string) {
  const at = nowIso();
  return { id, tenantId: ids.tenant, createdAt: at, updatedAt: at };
}

export function agentOrigin(overrides: Partial<Origin> = {}): Origin {
  return {
    by: { kind: "principal", id: ids.agentPrincipal },
    method: "llm",
    trust: "internal",
    sessionId: ids.session,
    at: nowIso(),
    ...overrides,
  };
}

export function connectorOrigin(overrides: Partial<Origin> = {}): Origin {
  return {
    by: { kind: "connection", id: ids.connection },
    method: "external",
    trust: "partner",
    at: nowIso(),
    ...overrides,
  };
}
