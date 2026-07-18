import type { z } from "zod";
import type {
  Connection,
  HumanRequest,
  IsoDateTime,
  Ref,
  SkillManifest,
  Ulid,
  WorkItem,
} from "@lithis/core";
import { skillManifestSchema } from "@lithis/core";

/**
 * Skill authoring kit. A skill's manifest (description, input schema,
 * capabilities required, triggers, self-modification bounds) is validated
 * against the canonical @lithis/core schema at authoring time so a bad
 * manifest fails in the author's editor/tests, not at registry propose time.
 *
 * The runtime contract lives here too: a skill exports `run: SkillRun`. The
 * server's skill invoker builds the SkillRunContext from its real services;
 * every surface is optional, and a skill MUST degrade honestly when a surface
 * it wants is absent (say so in its result — never fabricate).
 */

export type SkillManifestInput = z.input<typeof skillManifestSchema>;

/** Validate + normalize a skill manifest. Throws ZodError on invalid input. */
export function defineSkillManifest(data: SkillManifestInput): SkillManifest {
  return skillManifestSchema.parse(data);
}

// ── the run contract ────────────────────────────────────────────────────────

/** Read/advance surface over the work graph (server: WorkQueue adapters). */
export interface SkillWorkSurface {
  /** Work items whose followUp.nextAt is due at `now` (open items only). */
  dueFollowUps(now: IsoDateTime): Promise<WorkItem[]>;
  get(id: Ulid): Promise<WorkItem | undefined>;
  /** After a follow-up send: stamp lastContactAt and the next cadence wake. */
  recordFollowUpContact(id: Ulid, lastContactAt: IsoDateTime, nextAt: IsoDateTime): Promise<void>;
  /** Items updated since `since`, newest first (reporting windows). */
  listRecent(opts: { since: IsoDateTime; limit?: number }): Promise<WorkItem[]>;
}

/** Human-gate surface: tenant-wide pending reads + notifications (escalations). */
export interface SkillApprovalsSurface {
  listPending(): Promise<HumanRequest[]>;
  /** Open a HumanRequest{kind:"notification"}; returns its id. */
  notify(input: {
    summary: string;
    subjectRef: Ref;
    /** Routes to this principal; defaults to the tenant-admin role. */
    assigneePrincipalId?: Ulid;
    payload?: unknown;
  }): Promise<Ulid>;
}

export interface SkillConnectionsSurface {
  list(): Promise<Connection[]>;
}

export interface SkillDeliverResult {
  sent: boolean;
  /** Why not / transport detail — config degrades land here, never thrown. */
  detail?: string;
  deliveryRecordId?: Ulid;
}

/** Delivery hand-off: one rendered card per send, honest ledger either way. */
export interface SkillDeliverSurface {
  send(input: {
    kind: "digest" | "nudge";
    title: string;
    markdown: string;
    workItemId?: Ulid;
  }): Promise<SkillDeliverResult>;
}

/** One-pass LLM completion (prompt in, text out); absent when unconfigured. */
export type SkillCompleteFn = (prompt: string) => Promise<string>;

export interface SkillRunContext {
  tenantId: Ulid;
  /** The run's wall clock (injectable — schedule ticks pass the tick minute). */
  now: IsoDateTime;
  work?: SkillWorkSurface;
  approvals?: SkillApprovalsSurface;
  connections?: SkillConnectionsSurface;
  deliver?: SkillDeliverSurface;
  complete?: SkillCompleteFn;
}

/** Skill entrypoint — the invoker calls this with validated input + context. */
export type SkillRun = (
  input: Record<string, unknown>,
  ctx: SkillRunContext,
) => Promise<unknown>;
