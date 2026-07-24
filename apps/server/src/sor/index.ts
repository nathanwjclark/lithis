import type { Origin, PrincipalContext, Ref, SorDescriptor, Ulid } from "@lithis/core";
import { stub } from "@lithis/stubkit";
import type { ContextStore } from "../context";
import type { Db } from "../db";
import type { HumanGate, HumanRequestId } from "../humangate";
import type { EventSpine } from "../spine";
import { createPgSorRuntime } from "./service";
import type { SorSystemState } from "./service";

/**
 * sor — generated SQL systems-of-record ("Systems" in the portal). Tables
 * live in sor_{tenant}_{slug} Postgres schemas; every generated table carries
 * _id (primary key), _origin and _entity_ref columns (the CRM link +
 * provenance — structural, no fact-grading). Migrations are approval-gated
 * (HumanRequest{sor_migration}) and recorded with who applied them.
 *
 * REAL as of phase P11 — see ddl.ts (identifier validation + additive-only DDL
 * generation; descriptor-supplied identifiers are treated as hostile input)
 * and service.ts (propose → gate → apply, and the scoped table handle).
 *
 * v1 applies ADDITIVE migrations only. Dropping a table or column, changing a
 * column's type, and tightening nullability are rejected loudly rather than
 * half-implemented — they need a data-migration plan and their own gate.
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

/** A row as it comes back from a scoped handle: user columns + lithis columns. */
export type SorRow<T> = T & SorRowMeta & { _id: Ulid };

export interface SorInsertOptions {
  /** Overrides for the stamped Origin; `by` and `at` always come from the runtime. */
  origin?: Partial<Pick<Origin, "method" | "trust" | "sessionId">>;
  /**
   * The context entity this row links to. Accepted only on tables that declare
   * at least one `entityBinding` column; see the entity-binding stub below for
   * why it is not resolved automatically yet.
   */
  entityRef?: Ref;
}

/**
 * Tenant-schema-scoped table handle — the ONLY way rows are touched (no raw
 * SQL surface for agents). Every identifier comes from the APPLIED descriptor
 * and is quoted; every value is a bound parameter; unknown columns throw.
 */
export interface ScopedTable<T> {
  /** Stamps `_origin` (and `_entityRef` when supplied); returns the stored row. */
  insert(row: T, opts?: SorInsertOptions): Promise<SorRow<T>>;
  /** Parameterized UPDATE restricted to declared columns; empty where is refused. */
  update(where: Partial<T>, patch: Partial<T>): Promise<number>;
  select(where?: Partial<T>): Promise<SorRow<T>[]>;
}

export interface SorRuntime {
  /**
   * Diffs the draft against the APPLIED schema, renders DDL, stores it as a
   * blob and gates it via HumanRequest{sor_migration}. Throws
   * SorDestructiveMigrationError when the diff is not purely additive.
   */
  propose(draft: SorDescriptorDraft, p: PrincipalContext): Promise<HumanRequestId>;
  /** Only after approval — applies the descriptor's pending migration. */
  apply(descriptorId: Ulid, p: PrincipalContext): Promise<void>;
  /**
   * e.g. table<PolicyRow>("ams", "policies", p) — scoped to the CALLER's tenant
   * schema. The PrincipalContext is an explicit parameter (P11 signature
   * change): tenancy and provenance are caller facts, never ambient state.
   */
  table<T>(system: string, name: string, p: PrincipalContext): ScopedTable<T>;
  list(tenantId: Ulid): Promise<SorSystemState[]>;
  get(id: Ulid, tenantId: Ulid): Promise<SorSystemState | undefined>;
  getBySlug(tenantId: Ulid, slug: string): Promise<SorSystemState | undefined>;
}

/**
 * `entityBinding` declares that a column's VALUE names a context entity
 * (e.g. `client_legal_name → company`). Turning that value into an entity id
 * needs a context-store lookup surface that does not exist (search() is a
 * fuzzy hybrid ranker — binding a row to whatever it ranks first is exactly
 * the plausible-but-wrong behaviour this repo forbids). Until that surface
 * lands, callers pass `entityRef` explicitly. Registered so the census shows
 * the gap; nothing calls it.
 */
export const resolveEntityBinding = stub<(tenantId: Ulid, binding: string, value: unknown) => Promise<Ref>>(
  "server.sor.runtime.entity_binding",
  "LITHIS-STUB: automatic entityBinding → context-entity resolution not implemented (ContextStore exposes no exact entity lookup); callers supply entityRef explicitly",
);

export interface SorRuntimeWiringDeps {
  db: Db;
  spine: EventSpine;
  humanGate: HumanGate;
  /** Rendered DDL is stored as a blob so the approval card cites immutable bytes. */
  contextStore: ContextStore;
}

/** Wire the real runtime over shared deps (main.ts and integration tests). */
export function createSorRuntime(deps: SorRuntimeWiringDeps): SorRuntime {
  return createPgSorRuntime(deps);
}

/**
 * DB-less skeleton mode (DATABASE_URL unset): the runtime cannot run. Honest
 * CONFIG degrade, not a stub — the real implementation exists and is wired
 * whenever a database is configured.
 */
export function createUnconfiguredSorRuntime(): SorRuntime {
  const fail = (): never => {
    throw new Error(
      "SoR runtime unavailable: DATABASE_URL is not set — the server is running in DB-less skeleton mode",
    );
  };
  return {
    propose: fail,
    apply: fail,
    table: fail,
    list: fail,
    get: fail,
    getBySlug: fail,
  };
}

export {
  MAX_SOR_SLUG_LENGTH,
  RESERVED_COLUMNS,
  RESERVED_ENTITY_REF_COLUMN,
  RESERVED_ORIGIN_COLUMN,
  RESERVED_PK_COLUMN,
  SorDestructiveMigrationError,
  SorIdentifierError,
  diffTables,
  quoteIdent,
  quoteLiteral,
  renderCreateTable,
  renderMigration,
  sorSchemaName,
  validateTables,
} from "./ddl";
export type { RenderedMigration, SorDiff } from "./ddl";
export {
  SorColumnError,
  SorDescriptorNotFoundError,
  SorNotApprovedError,
  SorProposalPendingError,
  SorSchemaNotAppliedError,
  sorMigrationPayloadSchema,
} from "./service";
export type { SorMigrationPayload, SorSystemState } from "./service";
