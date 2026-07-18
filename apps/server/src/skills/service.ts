import {
  newUlid,
  nowIso,
  skillManifestSchema,
  skillSchema,
  skillVersionSchema,
} from "@lithis/core";
import type {
  Capability,
  PrincipalContext,
  Skill,
  SkillManifest,
  SkillVersion,
  Ulid,
} from "@lithis/core";
import { txSql } from "../db";
import type { Db } from "../db";
import type { EventSpine } from "../spine";
import type { HumanGate } from "../humangate";
import type { SkillRuntime } from "./runtime";
import type { SkillRegistry, SkillRunRecord, SkillVersionDraft } from "./index";

/**
 * The Postgres-backed SkillRegistry: propose → approve (HumanRequest
 * {subjectKind:"skill_change"}) → activate, checksum-bound.
 *
 * The checksum is a sha256 over the CANONICAL JSON (recursively sorted keys)
 * of the MANIFEST, computed identically at propose and activate. This is
 * deliberate and documented: with in-process registration there is no source
 * bundle to hash — hashing a git tree the server never reads would be
 * unverifiable theater. The manifest is exactly the surface a human approves
 * (description, input schema, capabilities, triggers, self-mod bounds), and
 * activation re-derives the checksum from the CURRENTLY REGISTERED runtime
 * manifest, so registry state and shipped code cannot silently drift.
 *
 * The eval gate is NOT run at propose (P16-evals pending) — see the loud
 * `server.skills.registry.evalgate` stub in index.ts; the approval payload
 * carries `evals: "not_run (P16-evals pending)"` so the approver sees the gap.
 */

export class SkillChecksumMismatchError extends Error {
  constructor(
    readonly slug: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `skill '${slug}' checksum mismatch: approved version is bound to ${expected}, ` +
        `but the registered runtime manifest hashes to ${actual} — re-propose the current manifest`,
    );
    this.name = "SkillChecksumMismatchError";
  }
}

export class SkillNotApprovedError extends Error {
  constructor(versionId: string, state: string) {
    super(`skill version ${versionId} cannot activate: its approval request is '${state}', not 'approved'`);
    this.name = "SkillNotApprovedError";
  }
}

/** JSON with recursively sorted object keys — key order can never change a checksum. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 hex of the canonical-JSON manifest (normalized through the core schema). */
export function manifestChecksum(manifest: SkillManifest): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonicalJson(skillManifestSchema.parse(manifest)));
  return hasher.digest("hex");
}

/** Bun's SQL client returns jsonb columns as JSON text — parse before zod. */
function fromJsonb(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

interface SkillRow {
  id: string;
  tenant_id: string;
  shared: boolean;
  slug: string;
  kind: string;
  current_version_id: string | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SkillVersionRow {
  id: string;
  tenant_id: string;
  skill_id: string;
  semver: string;
  source_ref: unknown;
  checksum: string;
  manifest: unknown;
  capability_diff: unknown;
  eval_run_id: string | null;
  approval_request_id: string | null;
  authored_by: unknown;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SkillRunRow {
  id: string;
  tenant_id: string;
  skill_id: string;
  version_id: string;
  trigger: string;
  input: unknown;
  status: string;
  result: unknown;
  error: string | null;
  started_at: Date | string;
  finished_at: Date | string | null;
}

export function rowToSkill(row: SkillRow): Skill {
  return skillSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    shared: row.shared,
    slug: row.slug,
    kind: row.kind,
    ...(row.current_version_id !== null ? { currentVersionId: row.current_version_id } : {}),
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

function rowToVersion(row: SkillVersionRow): SkillVersion {
  return skillVersionSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    skillId: row.skill_id,
    semver: row.semver,
    sourceRef: fromJsonb(row.source_ref),
    checksum: row.checksum,
    manifest: fromJsonb(row.manifest),
    capabilityDiff: fromJsonb(row.capability_diff),
    ...(row.eval_run_id !== null ? { evalRunId: row.eval_run_id } : {}),
    ...(row.approval_request_id !== null ? { approvalRequestId: row.approval_request_id } : {}),
    authoredBy: fromJsonb(row.authored_by),
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

export function rowToRunRecord(row: SkillRunRow): SkillRunRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    skillId: row.skill_id,
    versionId: row.version_id,
    trigger: row.trigger as SkillRunRecord["trigger"],
    input: (fromJsonb(row.input) ?? {}) as Record<string, unknown>,
    status: row.status as SkillRunRecord["status"],
    ...(row.result !== null ? { result: fromJsonb(row.result) } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    startedAt: toIso(row.started_at),
    ...(row.finished_at !== null ? { finishedAt: toIso(row.finished_at) } : {}),
  };
}

export interface PgSkillRegistryDeps {
  db: Db;
  spine: EventSpine;
  humanGate: HumanGate;
  runtime: SkillRuntime;
}

export function createPgSkillRegistry(deps: PgSkillRegistryDeps): SkillRegistry {
  const { db, spine, humanGate, runtime } = deps;

  async function loadVersion(versionId: Ulid, tenantId: Ulid): Promise<SkillVersion> {
    const rows: SkillVersionRow[] = await db.sql`
      select * from skills.skill_versions where id = ${versionId} and tenant_id = ${tenantId}`;
    const row = rows[0];
    if (row === undefined) throw new Error(`skill version ${versionId} not found`);
    return rowToVersion(row);
  }

  return {
    async propose(draft: SkillVersionDraft) {
      const manifest = skillManifestSchema.parse(draft.manifest);
      const checksum = manifestChecksum(manifest);
      const at = nowIso();
      const versionId = newUlid();

      const { skillId, capabilityDiff } = await db.withTx(async (tx) => {
        const sql = txSql(tx);
        const skillRows: SkillRow[] = await sql`
          select * from skills.skills
          where tenant_id = ${draft.tenantId} and slug = ${draft.slug}
          for update`;
        let skillId = skillRows[0]?.id;
        if (skillId === undefined) {
          skillId = newUlid();
          await sql`
            insert into skills.skills
              (id, tenant_id, shared, slug, kind, current_version_id, status, created_at, updated_at)
            values
              (${skillId}, ${draft.tenantId}, false, ${draft.slug}, ${draft.kind}, null, 'active', ${at}, ${at})`;
        }

        // capabilityDiff vs the currently active version — the creep check a
        // human reviews (all-added when there is no active version yet).
        const activeRows: SkillVersionRow[] = await sql`
          select * from skills.skill_versions
          where skill_id = ${skillId} and status = 'active'`;
        const prior: Capability[] =
          activeRows[0] !== undefined
            ? rowToVersion(activeRows[0]).manifest.capabilitiesRequired
            : [];
        const next = manifest.capabilitiesRequired;
        const capabilityDiff = {
          added: next.filter((c) => !prior.includes(c)),
          removed: prior.filter((c) => !next.includes(c)),
        };

        await sql`
          insert into skills.skill_versions
            (id, tenant_id, skill_id, semver, source_ref, checksum, manifest,
             capability_diff, eval_run_id, approval_request_id, authored_by, status,
             created_at, updated_at)
          values
            (${versionId}, ${draft.tenantId}, ${skillId}, ${draft.semver},
             ${JSON.stringify(draft.sourceRef)}::text::jsonb, ${checksum},
             ${JSON.stringify(manifest)}::text::jsonb,
             ${JSON.stringify(capabilityDiff)}::text::jsonb,
             null, null, ${JSON.stringify(draft.authoredBy)}::text::jsonb, 'proposed',
             ${at}, ${at})`;
        await spine.append(tx, {
          tenantId: draft.tenantId,
          topic: "skill.version.proposed",
          subjectRefs: [
            { kind: "skill", id: skillId },
            { kind: "skill_version", id: versionId },
          ],
          actor: draft.authoredBy,
          payload: { semver: draft.semver, capabilityAdded: capabilityDiff.added },
        });
        return { skillId, capabilityDiff };
      });

      // The gate write runs in its own transaction (humanGate owns its outbox);
      // the version's approval_request_id back-link lands right after.
      const request = await humanGate.request({
        tenantId: draft.tenantId,
        kind: "approval",
        subjectKind: "skill_change",
        subjectRef: { kind: "skill_version", id: versionId },
        payload: {
          slug: draft.slug,
          semver: draft.semver,
          checksum,
          capabilityDiff,
          sourceRef: draft.sourceRef,
          // The eval gate is pending (P16) — the approver must see the gap.
          evals: "not_run (P16-evals pending)",
        },
        evidenceIds: [],
        summary:
          `Activate skill '${draft.slug}' v${draft.semver}? ` +
          `Capabilities added: ${capabilityDiff.added.length === 0 ? "none" : capabilityDiff.added.join(", ")}; ` +
          `removed: ${capabilityDiff.removed.length === 0 ? "none" : capabilityDiff.removed.join(", ")}. ` +
          `Evals: not_run (P16-evals pending).`,
        routing: { assignee: "tenant-admin", channelPrefs: ["portal"], escalationPath: [], followUpCount: 0 },
        requestedBy: draft.authoredBy,
      });
      await db.sql`
        update skills.skill_versions
        set approval_request_id = ${request.id}, updated_at = ${nowIso()}
        where id = ${versionId}`;

      return { skillId, versionId, approvalRequestId: request.id };
    },

    async activate(versionId: Ulid, tenantId: Ulid): Promise<void> {
      const version = await loadVersion(versionId, tenantId);
      if (version.status !== "proposed" && version.status !== "approved") {
        throw new Error(`skill version ${versionId} cannot activate from status '${version.status}'`);
      }
      if (version.approvalRequestId === undefined) {
        throw new SkillNotApprovedError(versionId, "missing");
      }
      const approval = await humanGate.get(version.approvalRequestId, tenantId);
      if (approval === undefined || approval.state !== "approved") {
        throw new SkillNotApprovedError(versionId, approval?.state ?? "missing");
      }

      const skillRows: SkillRow[] = await db.sql`
        select * from skills.skills where id = ${version.skillId} and tenant_id = ${tenantId}`;
      const skill = skillRows[0];
      if (skill === undefined) throw new Error(`skill ${version.skillId} not found`);

      // Checksum binding: the approved manifest must be EXACTLY what this
      // server build registered — drift throws, never silently activates.
      const registration = runtime.resolve(skill.slug);
      if (registration === undefined) {
        throw new Error(
          `skill '${skill.slug}' is not registered in this server build — cannot verify the checksum binding`,
        );
      }
      const actual = manifestChecksum(registration.manifest);
      if (actual !== version.checksum) {
        throw new SkillChecksumMismatchError(skill.slug, version.checksum, actual);
      }

      const at = nowIso();
      await db.withTx(async (tx) => {
        const sql = txSql(tx);
        await sql`
          update skills.skill_versions
          set status = 'retired', updated_at = ${at}
          where skill_id = ${version.skillId} and status = 'active'`;
        await sql`
          update skills.skill_versions
          set status = 'active', updated_at = ${at}
          where id = ${versionId}`;
        await sql`
          update skills.skills
          set current_version_id = ${versionId}, status = 'active', updated_at = ${at}
          where id = ${version.skillId}`;
        await spine.append(tx, {
          tenantId,
          topic: "skill.version.activated",
          subjectRefs: [
            { kind: "skill", id: version.skillId },
            { kind: "skill_version", id: versionId },
          ],
          actor: approval.resolution?.by ?? { kind: "tenant", id: tenantId },
          payload: { semver: version.semver, checksum: version.checksum },
        });
      });
    },

    /**
     * The skills this principal may invoke: the tenant's active skills.
     * Grant intersection stays deferred with the policy layer (ADR-006) —
     * charter role prose guides usage; enforcement arrives with Grants.
     */
    async forPrincipal(p: PrincipalContext): Promise<Skill[]> {
      const rows: SkillRow[] = await db.sql`
        select * from skills.skills
        where tenant_id = ${p.tenantId} and status = 'active' and current_version_id is not null
        order by slug`;
      return rows.map(rowToSkill);
    },

    async list(tenantId: Ulid): Promise<Skill[]> {
      const rows: SkillRow[] = await db.sql`
        select * from skills.skills where tenant_id = ${tenantId} order by slug`;
      return rows.map(rowToSkill);
    },

    async runsFor(tenantId: Ulid, slug: string): Promise<SkillRunRecord[]> {
      const rows: SkillRunRow[] = await db.sql`
        select r.* from skills.skill_runs r
        join skills.skills s on s.id = r.skill_id
        where r.tenant_id = ${tenantId} and s.slug = ${slug}
        order by r.id desc
        limit 100`;
      return rows.map(rowToRunRecord);
    },
  };
}
