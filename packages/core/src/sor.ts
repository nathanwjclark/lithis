import { z } from "zod";
import { recordBase, slugSchema } from "./common";
import { isoDateTimeSchema, ulidSchema } from "./ids";

/**
 * Generated systems-of-record: real SQL, declaratively described, tightly
 * linked to the context store. Tables live in sor_{tenant}_{slug} Postgres
 * schemas; every table carries _entityRef + _origin columns (the CRM link +
 * provenance — no fact-grading columns). Migrations are approval-gated and
 * recorded with who applied them (agent | human).
 */

export const SOR_COLUMN_TYPES = [
  "text",
  "integer",
  "numeric",
  "boolean",
  "date",
  "timestamptz",
  "jsonb",
] as const;

export const sorColumnSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "snake_case column name")
    .refine((n) => !n.startsWith("_"), { message: "underscore-prefixed columns are reserved for lithis" }),
  type: z.enum(SOR_COLUMN_TYPES),
  nullable: z.boolean().default(true),
  description: z.string().optional(),
  /** Binds this column to a context entity type (e.g. client_name → person). */
  entityBinding: slugSchema.optional(),
});

export const sorTableSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string(),
  columns: z.array(sorColumnSchema).min(1),
});
export type SorTable = z.infer<typeof sorTableSchema>;

export const sorMigrationSchema = z.object({
  version: z.number().int().positive(),
  sqlBlobId: ulidSchema,
  appliedBy: z.enum(["agent", "human"]),
  approvalRequestId: ulidSchema,
  appliedAt: isoDateTimeSchema.optional(),
});

export const sorDescriptorSchema = z.object({
  ...recordBase,
  slug: slugSchema,
  displayName: z.string().min(1),
  version: z.number().int().positive(),
  tables: z.array(sorTableSchema).min(1),
  /** Rendered DDL for the current version (blob). */
  ddlBlobId: ulidSchema.optional(),
  migrations: z.array(sorMigrationSchema).default([]),
});
export type SorDescriptor = z.infer<typeof sorDescriptorSchema>;
