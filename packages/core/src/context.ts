import { z } from "zod";
import { recordBase, revisioned, slugSchema } from "./common";
import { isoDateTimeSchema, ulidSchema } from "./ids";
import { originSchema } from "./origin";
import { refSchema } from "./refs";

/**
 * Context — ingest, don't curate. Blobs and docs land as-is (quarantined by
 * default); the ingest-time distill pass writes summary + entities + links
 * once; the deterministic index (FTS + pgvector chunks) is built synchronously
 * at ingest. NO periodic link add/prune/maintenance jobs — association
 * discovery happens at query time. NO fact-grading fields anywhere here.
 */

export const blobSchema = z.object({
  ...recordBase,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  /** Object-storage location (s3://... or minio path). Bytes never live in Postgres. */
  storageRef: z.string().min(1),
  origin: originSchema,
});
export type Blob = z.infer<typeof blobSchema>;

export const docSchema = z.object({
  ...revisioned,
  /** Doc type from the active SchemaPack (e.g. meeting, email, loss_run, note). */
  type: slugSchema,
  slug: slugSchema,
  title: z.string().min(1),
  bodyBlobId: ulidSchema,
  frontmatter: z.record(z.unknown()),
  /** Written once by the ingest-time distill pass. */
  summary: z.string().optional(),
  /** Quarantined content is DATA for prompts, never instructions. Default on. */
  quarantined: z.boolean().default(true),
  origin: originSchema,
});
export type Doc = z.infer<typeof docSchema>;

export const CORE_ENTITY_TYPES = ["person", "company", "project", "concept"] as const;

/** Degree: 1 = real network, 2 = prospect (BD). Required on person/company. */
export const degreeSchema = z.union([z.literal(1), z.literal(2)]);

export const entitySchema = z
  .object({
    ...revisioned,
    /** Core type or a pack-defined extension type. */
    type: slugSchema,
    slug: slugSchema,
    name: z.string().min(1),
    /** Typed per entity-type via the SchemaPack; validated at the module layer. */
    attrs: z.record(z.unknown()),
    degree: degreeSchema.optional(),
    origin: originSchema,
  })
  .superRefine((entity, ctx) => {
    if ((entity.type === "person" || entity.type === "company") && entity.degree === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["degree"],
        message: "degree is REQUIRED on person/company entities (1 = network, 2 = prospect)",
      });
    }
  });
export type Entity = z.infer<typeof entitySchema>;

export const linkSchema = z.object({
  ...recordBase,
  fromRef: refSchema,
  toRef: refSchema,
  /** Verb from the pack catalog (works_at, knows, relevant_to, mentions, ...). */
  verb: slugSchema,
  weight: z.number().min(0).max(1).default(1),
  /** Who asserted this link, in which session. */
  origin: originSchema,
});
export type Link = z.infer<typeof linkSchema>;

/** The deterministic index row: FTS + vector, built synchronously at ingest. */
export const chunkSchema = z.object({
  id: ulidSchema,
  tenantId: ulidSchema,
  docId: ulidSchema,
  ord: z.number().int().nonnegative(),
  text: z.string(),
  /** pgvector column in Postgres; serialized as number[] at the API boundary. */
  embedding: z.array(z.number()).optional(),
  createdAt: isoDateTimeSchema,
});
export type Chunk = z.infer<typeof chunkSchema>;

export const schemaPackSchema = z.object({
  slug: slugSchema,
  version: z.string().min(1),
  entityTypes: z.array(
    z.object({
      type: slugSchema,
      description: z.string(),
      /** JSON-schema-ish attr spec; concrete zod built at the module layer. */
      attrs: z.record(z.unknown()).optional(),
    }),
  ),
  docTypes: z.array(z.object({ type: slugSchema, description: z.string() })),
  linkVerbs: z.array(
    z.object({
      verb: slugSchema,
      description: z.string(),
      inverse: slugSchema.optional(),
    }),
  ),
  /** Legacy type → canonical type mappings applied at ingest. */
  retypeRules: z.array(z.object({ from: slugSchema, to: slugSchema })).default([]),
});
export type SchemaPack = z.infer<typeof schemaPackSchema>;

/**
 * Relationship scores — deterministic kinds refresh daily (code, free), LLM
 * kinds weekly; deterministic runs never overwrite LLM judgments (crm lesson).
 */
export const RELATIONSHIP_SCORE_KINDS = [
  "strength",
  "cadence",
  "trajectory",
  "tier",
  "potential",
] as const;

export const relationshipScoreSchema = z.object({
  tenantId: ulidSchema,
  entityId: ulidSchema,
  kind: z.enum(RELATIONSHIP_SCORE_KINDS),
  value: z.union([z.number(), z.string()]),
  method: z.enum(["code", "llm"]),
  why: z.string().optional(),
  computedAt: isoDateTimeSchema,
});
export type RelationshipScore = z.infer<typeof relationshipScoreSchema>;

/** Query-side audience guard — the degree choke point. Defaults to 'network'. */
export const audienceSchema = z.enum(["network", "prospecting", "all"]);
export type Audience = z.infer<typeof audienceSchema>;
