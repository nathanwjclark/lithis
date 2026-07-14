import { z } from "zod";
import { ulidSchema } from "./ids";

/**
 * The CLOSED RefKind enum. Every pointer between records is a Ref; adding a
 * kind here is a deliberate schema decision (tests enforce closure).
 */
export const REF_KINDS = [
  "tenant",
  "principal",
  "session",
  "entity",
  "blob",
  "doc",
  "link",
  "work_item",
  "process_run",
  "run",
  "run_result",
  "evidence",
  "human_request",
  "action_intent",
  "connection",
  "credential",
  "skill",
  "skill_version",
  "template",
  "artifact",
  "sor_schema",
  "sor_row",
  "workspace",
  "event",
] as const;

export const refKindSchema = z.enum(REF_KINDS);
export type RefKind = z.infer<typeof refKindSchema>;

/** Universal typed pointer. */
export const refSchema = z.object({
  kind: refKindSchema,
  id: ulidSchema,
});
export type Ref = z.infer<typeof refSchema>;

export function ref(kind: RefKind, id: string): Ref {
  return refSchema.parse({ kind, id });
}

export function sameRef(a: Ref, b: Ref): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** Canonical string form, e.g. "doc:01H..." — used in hashes and logs. */
export function refToString(r: Ref): string {
  return `${r.kind}:${r.id}`;
}
