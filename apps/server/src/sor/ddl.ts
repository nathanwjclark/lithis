import { SOR_COLUMN_TYPES, sorTableSchema } from "@lithis/core";
import type { SorTable, Ulid } from "@lithis/core";

/**
 * DDL generation for generated systems-of-record.
 *
 * THE threat model for this file: a SorDescriptor is DATA. Packs ship them,
 * agents draft them, humans edit them in the portal — so every identifier that
 * reaches SQL here is treated as hostile input. Two defences, both mandatory:
 *
 *  1. every identifier is re-validated against a strict regex at DDL time
 *     (the core zod already enforces the shape; belt AND braces, because a
 *     descriptor can also arrive from a JSON column written by an older build);
 *  2. every identifier is double-quoted, and every string literal (table and
 *     column comments) is single-quote-escaped.
 *
 * There is deliberately no path in this module that concatenates an
 * unvalidated string into SQL.
 */

/** Postgres identifiers are 63 bytes; we require snake_case ASCII on top. */
const IDENT_RE = /^[a-z][a-z0-9_]*$/;
const MAX_IDENT_LEN = 63;

/** Columns lithis owns on every generated table (user columns can never start with `_`). */
export const RESERVED_PK_COLUMN = "_id";
export const RESERVED_ORIGIN_COLUMN = "_origin";
export const RESERVED_ENTITY_REF_COLUMN = "_entity_ref";
export const RESERVED_COLUMNS = [
  RESERVED_PK_COLUMN,
  RESERVED_ORIGIN_COLUMN,
  RESERVED_ENTITY_REF_COLUMN,
] as const;

/** `sor_` + 26-char ULID + `_` = 31 characters of prefix inside the 63-byte budget. */
export const MAX_SOR_SLUG_LENGTH = MAX_IDENT_LEN - 31;

export class SorIdentifierError extends Error {
  constructor(what: string, value: string, why: string) {
    super(`invalid SoR ${what} '${value}': ${why}`);
    this.name = "SorIdentifierError";
  }
}

export class SorDestructiveMigrationError extends Error {
  constructor(readonly changes: string[]) {
    super(
      `SoR migration rejected — v1 applies ADDITIVE changes only, and this diff is destructive:\n` +
        changes.map((c) => `  - ${c}`).join("\n") +
        `\nDropping tables/columns, changing a column's type, and tightening nullability are ` +
        `deliberately not implemented: they need a data-migration plan and a separate gate. ` +
        `Publish the change as a new column instead, or take it up as a follow-up.`,
    );
    this.name = "SorDestructiveMigrationError";
  }
}

/** Validate + double-quote an identifier. The ONLY way an identifier reaches SQL. */
export function quoteIdent(value: string, what: string, opts?: { allowReserved?: boolean }): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SorIdentifierError(what, String(value), "must be a non-empty string");
  }
  if (value.length > MAX_IDENT_LEN) {
    throw new SorIdentifierError(what, value, `exceeds the ${MAX_IDENT_LEN}-character Postgres identifier limit`);
  }
  if (opts?.allowReserved === true) {
    if (!(RESERVED_COLUMNS as readonly string[]).includes(value)) {
      throw new SorIdentifierError(what, value, "is not one of the reserved lithis columns");
    }
    return `"${value}"`;
  }
  if (!IDENT_RE.test(value)) {
    throw new SorIdentifierError(
      what,
      value,
      "must match /^[a-z][a-z0-9_]*$/ (lowercase snake_case, no leading underscore, no quotes or spaces)",
    );
  }
  return `"${value}"`;
}

/**
 * Escape a string for use as a SQL literal. Only descriptor prose (table and
 * column comments) ever reaches this — identifiers go through quoteIdent.
 */
export function quoteLiteral(value: string): string {
  if (value.includes("\u0000")) {
    throw new SorIdentifierError("descriptor text", value.slice(0, 40), "must not contain NUL bytes");
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/** `sor_{lowercased tenant ULID}_{slug}` — the per-tenant schema for one system. */
export function sorSchemaName(tenantId: Ulid, slug: string): string {
  if (!/^[0-9A-Za-z]{26}$/.test(tenantId)) {
    throw new SorIdentifierError("tenant id", tenantId, "must be a 26-character ULID");
  }
  if (!IDENT_RE.test(slug)) {
    throw new SorIdentifierError(
      "system slug",
      slug,
      "must match /^[a-z][a-z0-9_]*$/ to be usable as a Postgres schema name",
    );
  }
  if (slug.length > MAX_SOR_SLUG_LENGTH) {
    throw new SorIdentifierError(
      "system slug",
      slug,
      `is too long: sor_{tenant}_{slug} must fit ${MAX_IDENT_LEN} characters, so the slug may be at most ${MAX_SOR_SLUG_LENGTH}`,
    );
  }
  return `sor_${tenantId.toLowerCase()}_${slug}`;
}

const COLUMN_SQL_TYPE: Record<(typeof SOR_COLUMN_TYPES)[number], string> = {
  text: "text",
  integer: "integer",
  numeric: "numeric",
  boolean: "boolean",
  date: "date",
  timestamptz: "timestamptz",
  jsonb: "jsonb",
};

function sqlType(type: string, table: string, column: string): string {
  const mapped = COLUMN_SQL_TYPE[type as (typeof SOR_COLUMN_TYPES)[number]];
  if (mapped === undefined) {
    throw new SorIdentifierError(
      "column type",
      `${table}.${column}: ${type}`,
      `must be one of ${SOR_COLUMN_TYPES.join(", ")}`,
    );
  }
  return mapped;
}

/**
 * Re-validate a descriptor's tables through the core schema AND the identifier
 * rules, and reject user columns colliding with the reserved names.
 */
export function validateTables(tables: unknown): SorTable[] {
  const parsed = sorTableSchema.array().parse(tables);
  const seenTables = new Set<string>();
  for (const table of parsed) {
    quoteIdent(table.name, "table name");
    if (seenTables.has(table.name)) {
      throw new SorIdentifierError("table name", table.name, "is declared twice in the descriptor");
    }
    seenTables.add(table.name);
    const seenColumns = new Set<string>();
    for (const column of table.columns) {
      quoteIdent(column.name, `column name (${table.name})`);
      if ((RESERVED_COLUMNS as readonly string[]).includes(column.name)) {
        throw new SorIdentifierError(
          `column name (${table.name})`,
          column.name,
          "collides with a reserved lithis column",
        );
      }
      if (seenColumns.has(column.name)) {
        throw new SorIdentifierError(
          `column name (${table.name})`,
          column.name,
          "is declared twice on this table",
        );
      }
      seenColumns.add(column.name);
      sqlType(column.type, table.name, column.name);
    }
  }
  return parsed;
}

function columnClause(table: SorTable, column: SorTable["columns"][number]): string {
  return `${quoteIdent(column.name, `column name (${table.name})`)} ${sqlType(column.type, table.name, column.name)}${column.nullable ? "" : " not null"}`;
}

/**
 * The descriptor's prose for one column, with the entityBinding folded in so
 * the CRM link is visible to anyone reading the schema in psql.
 */
function columnComment(column: SorTable["columns"][number]): string | undefined {
  if (column.entityBinding === undefined) return column.description;
  const prefix = column.description === undefined ? "" : `${column.description} `;
  return `${prefix}[entityBinding: ${column.entityBinding}]`;
}

/** `comment on column …` for one column, or undefined when it has no prose. */
function columnCommentStatement(
  schema: string,
  table: SorTable,
  column: SorTable["columns"][number],
): string | undefined {
  const description = columnComment(column);
  if (description === undefined) return undefined;
  return `comment on column ${quoteIdent(schema, "schema name")}.${quoteIdent(table.name, "table name")}.${quoteIdent(column.name, `column name (${table.name})`)} is ${quoteLiteral(description)};`;
}

function commentStatements(schema: string, table: SorTable): string[] {
  const qSchema = quoteIdent(schema, "schema name");
  const qTable = quoteIdent(table.name, "table name");
  const out = [`comment on table ${qSchema}.${qTable} is ${quoteLiteral(table.description)};`];
  for (const column of table.columns) {
    const statement = columnCommentStatement(schema, table, column);
    if (statement !== undefined) out.push(statement);
  }
  return out;
}

/** CREATE TABLE for one descriptor table, with the reserved lithis columns. */
export function renderCreateTable(schema: string, table: SorTable): string[] {
  const qSchema = quoteIdent(schema, "schema name");
  const qTable = quoteIdent(table.name, "table name");
  const columns = [
    `${quoteIdent(RESERVED_PK_COLUMN, "reserved column", { allowReserved: true })} text primary key`,
    `${quoteIdent(RESERVED_ORIGIN_COLUMN, "reserved column", { allowReserved: true })} jsonb not null`,
    `${quoteIdent(RESERVED_ENTITY_REF_COLUMN, "reserved column", { allowReserved: true })} jsonb`,
    ...table.columns.map((c) => columnClause(table, c)),
  ];
  return [
    `create table ${qSchema}.${qTable} (\n  ${columns.join(",\n  ")}\n);`,
    ...commentStatements(schema, table),
  ];
}

export interface SorDiff {
  /** The ordered DDL statements this migration would run. */
  statements: string[];
  /** Human-readable summary of what changes (goes on the approval card). */
  summary: string[];
  /** Non-empty ⇒ the proposal must be rejected. */
  destructive: string[];
}

/**
 * Diff the applied table set against the proposed one.
 *
 * ADDITIVE ONLY in v1: new tables and new NULLABLE columns on existing tables.
 * Everything else — dropping a table or column, changing a column's type,
 * tightening nullability, and adding a NOT NULL column to a table that may
 * already hold rows — is collected in `destructive` and rejected loudly by the
 * caller rather than half-applied.
 */
export function diffTables(
  schema: string,
  prior: SorTable[],
  next: SorTable[],
): SorDiff {
  const statements: string[] = [];
  const summary: string[] = [];
  const destructive: string[] = [];
  const qSchema = quoteIdent(schema, "schema name");

  const priorByName = new Map(prior.map((t) => [t.name, t]));
  const nextByName = new Map(next.map((t) => [t.name, t]));

  for (const table of prior) {
    if (!nextByName.has(table.name)) {
      destructive.push(`table '${table.name}' would be dropped`);
    }
  }

  for (const table of next) {
    const before = priorByName.get(table.name);
    if (before === undefined) {
      statements.push(...renderCreateTable(schema, table));
      summary.push(`create table ${table.name} (${table.columns.length} column(s))`);
      continue;
    }
    const qTable = quoteIdent(table.name, "table name");
    const beforeColumns = new Map(before.columns.map((c) => [c.name, c]));
    const afterColumns = new Map(table.columns.map((c) => [c.name, c]));

    for (const column of before.columns) {
      if (!afterColumns.has(column.name)) {
        destructive.push(`column '${table.name}.${column.name}' would be dropped`);
      }
    }
    for (const column of table.columns) {
      const priorColumn = beforeColumns.get(column.name);
      if (priorColumn === undefined) {
        if (!column.nullable) {
          destructive.push(
            `column '${table.name}.${column.name}' would be added NOT NULL to an existing table ` +
              `(existing rows have no value for it) — add it nullable, backfill, then tighten`,
          );
          continue;
        }
        statements.push(
          `alter table ${qSchema}.${qTable} add column ${columnClause(table, column)};`,
        );
        const comment = columnCommentStatement(schema, table, column);
        if (comment !== undefined) statements.push(comment);
        summary.push(`add column ${table.name}.${column.name} ${column.type} null`);
        continue;
      }
      if (priorColumn.type !== column.type) {
        destructive.push(
          `column '${table.name}.${column.name}' would change type ${priorColumn.type} → ${column.type}`,
        );
        continue;
      }
      if (priorColumn.nullable !== column.nullable) {
        destructive.push(
          `column '${table.name}.${column.name}' would change nullability ${priorColumn.nullable} → ${column.nullable}`,
        );
        continue;
      }
      if (
        priorColumn.description !== column.description ||
        priorColumn.entityBinding !== column.entityBinding
      ) {
        const description = columnComment(column);
        statements.push(
          `comment on column ${qSchema}.${qTable}.${quoteIdent(column.name, `column name (${table.name})`)} is ${description === undefined ? "null" : quoteLiteral(description)};`,
        );
        summary.push(`update comment on ${table.name}.${column.name}`);
      }
    }
    if (before.description !== table.description) {
      statements.push(
        `comment on table ${qSchema}.${qTable} is ${quoteLiteral(table.description)};`,
      );
      summary.push(`update comment on table ${table.name}`);
    }
  }

  return { statements, summary, destructive };
}

export interface RenderedMigration {
  schema: string;
  sql: string;
  summary: string[];
}

/**
 * Full migration SQL for `prior → next`. Throws SorDestructiveMigrationError
 * when the diff is not purely additive. `create schema if not exists` leads,
 * so a first version provisions the schema itself.
 */
export function renderMigration(
  tenantId: Ulid,
  slug: string,
  version: number,
  prior: SorTable[],
  next: SorTable[],
): RenderedMigration {
  const schema = sorSchemaName(tenantId, slug);
  const validated = validateTables(next);
  const priorValidated = prior.length === 0 ? [] : validateTables(prior);
  const diff = diffTables(schema, priorValidated, validated);
  if (diff.destructive.length > 0) throw new SorDestructiveMigrationError(diff.destructive);
  if (diff.statements.length === 0) {
    throw new Error(
      `SoR '${slug}' v${version} proposes no schema change — nothing to migrate (the descriptor is identical to the applied version)`,
    );
  }
  const header = [
    `-- lithis SoR migration — system '${slug}' version ${version}`,
    `-- schema: ${schema}`,
    `-- generated from the SorDescriptor; every identifier is validated + quoted.`,
    `create schema if not exists ${quoteIdent(schema, "schema name")};`,
  ];
  return { schema, sql: [...header, ...diff.statements].join("\n"), summary: diff.summary };
}
