import type { Origin, Ref, SorDescriptor, Ulid } from "@lithis/core";
import { stubService } from "@lithis/stubkit";
import type { HumanRequestId } from "../humangate";

/**
 * sor — generated SQL systems-of-record ("Systems" in the portal). Tables
 * live in sor_{tenant}_{slug} Postgres schemas; every generated table carries
 * _entity_ref + _origin columns (the CRM link + provenance — structural, no
 * fact-grading). Migrations are approval-gated (HumanRequest{sor_migration})
 * and recorded with who applied them.
 */

export type SorDescriptorDraft = Omit<
  SorDescriptor,
  "id" | "createdAt" | "updatedAt" | "ddlBlobId" | "migrations"
>;

/** Columns lithis adds to every generated row — the context link + provenance. */
export interface SorRowMeta {
  _entityRef?: Ref;
  _origin: Origin;
}

/**
 * Tenant-schema-scoped table handle — the ONLY way rows are touched (no raw
 * SQL surface for agents).
 */
export interface ScopedTable<T> {
  insert(row: T & SorRowMeta): Promise<void>;
  update(where: Partial<T>, patch: Partial<T>): Promise<number>;
  select(where?: Partial<T>): Promise<Array<T & SorRowMeta>>;
}

export interface SorRuntime {
  /** Renders DDL, gates via HumanRequest{sor_migration}. */
  propose(draft: SorDescriptorDraft): Promise<HumanRequestId>;
  /** Only after approval — applies the descriptor's pending migration. */
  apply(descriptorId: Ulid): Promise<void>;
  /** e.g. table<PolicyRow>("ams", "policies") — scoped to the caller's tenant schema. */
  table<T>(system: string, name: string): ScopedTable<T>;
}

const sorRuntime = stubService<SorRuntime>(
  "server.sor.runtime",
  ["propose", "apply", "table"],
  "LITHIS-STUB: SoR DDL generation, approval-gated migrations, and scoped table access not implemented",
);

export function createSorRuntime(): SorRuntime {
  return sorRuntime;
}
