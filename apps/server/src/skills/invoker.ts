import { cronMatches, newUlid, nowIso, skillManifestSchema } from "@lithis/core";
import type { PrincipalContext, Ref, SkillManifest, Ulid } from "@lithis/core";
import type {
  SkillCompleteFn,
  SkillRunContext,
} from "@lithis/sdk/skills";
import { txSql } from "../db";
import type { Db } from "../db";
import type { EventSpine, TickSource } from "../spine";
import type { HumanGate } from "../humangate";
import type { WorkQueue } from "../work";
import type { ConnectionRegistry } from "../connections";
import type { Delivery } from "../delivery";
import { rowToRunRecord } from "./service";
import type { SkillRuntime } from "./runtime";
import type { SkillRunRecord, SkillToolExecutor } from "./index";

/**
 * The skill invoker — one invocation is one durable skills.skill_runs row
 * plus skill.run.started/finished events, whatever the trigger (schedule
 * tick, agent tool call, manual invoke). The SkillRunContext surfaces are
 * thin adapters over the REAL services; a dep that was not composed simply
 * leaves its surface absent and the skill degrades honestly.
 *
 * The scheduled path is a DIRECT in-process invocation — no LLM, no agent
 * loop; deterministic skills stay deterministic.
 */

export interface ActiveSkillRef {
  tenantId: Ulid;
  skillId: Ulid;
  versionId: Ulid;
  slug: string;
  manifest: SkillManifest;
}

export type SkillTrigger = SkillRunRecord["trigger"];

export interface SkillInvoker {
  invoke(
    skill: ActiveSkillRef,
    trigger: SkillTrigger,
    input: Record<string, unknown>,
    actor: Ref,
    /** The run's wall clock (the schedule tick passes its tick minute). */
    now?: Date,
  ): Promise<SkillRunRecord>;
}

export interface SkillInvokerDeps {
  db: Db;
  spine: EventSpine;
  runtime: SkillRuntime;
  humanGate: HumanGate;
  workQueue: WorkQueue;
  connections?: Pick<ConnectionRegistry, "list">;
  delivery?: Pick<Delivery, "route">;
  /** Default Slack channel skill cards post to (SLACK_DELIVERY_CHANNEL). */
  slackChannel?: string;
  /** One-pass LLM polish seam; absent when ANTHROPIC_API_KEY is unset. */
  complete?: SkillCompleteFn;
}

/** Slack section blocks cap at 3000 chars — truncate honestly, never drop. */
function truncateForSlack(markdown: string): string {
  return markdown.length <= 2_900 ? markdown : `${markdown.slice(0, 2_900)}\n… (truncated)`;
}

export function createSkillInvoker(deps: SkillInvokerDeps): SkillInvoker {
  const { db, spine, runtime } = deps;

  function buildContext(s: ActiveSkillRef, now: string, actor: Ref): SkillRunContext {
    return {
      tenantId: s.tenantId,
      now,
      work: {
        dueFollowUps: (at) => deps.workQueue.dueFollowUps(s.tenantId, at),
        get: (id) => deps.workQueue.get(id),
        recordFollowUpContact: (id, lastContactAt, nextAt) =>
          deps.workQueue.recordFollowUpContact(id, lastContactAt, nextAt),
        listRecent: (opts) => deps.workQueue.listRecent(s.tenantId, opts),
      },
      approvals: {
        listPending: () => deps.humanGate.listPending(s.tenantId),
        notify: async (input) => {
          const request = await deps.humanGate.request({
            tenantId: s.tenantId,
            kind: "notification",
            subjectKind: "action",
            subjectRef: input.subjectRef,
            payload: input.payload,
            evidenceIds: [],
            summary: input.summary,
            routing: {
              assignee:
                input.assigneePrincipalId !== undefined
                  ? { kind: "principal", id: input.assigneePrincipalId }
                  : "tenant-admin",
              channelPrefs: ["slack", "portal"],
              escalationPath: [],
              followUpCount: 0,
            },
            requestedBy: actor,
          });
          return request.id;
        },
      },
      ...(deps.connections !== undefined
        ? {
            connections: {
              list: () =>
                deps.connections!.list({
                  tenantId: s.tenantId,
                  principalId: s.tenantId,
                  kind: "service",
                }),
            },
          }
        : {}),
      ...(deps.delivery !== undefined
        ? {
            deliver: {
              send: async (input) => {
                if (deps.slackChannel === undefined) {
                  return {
                    sent: false,
                    detail:
                      "SLACK_DELIVERY_CHANNEL is not configured — skill delivery has nowhere to post",
                  };
                }
                const record = await deps.delivery!.route(
                  {
                    tenantId: s.tenantId,
                    channel: "slack",
                    kind: input.kind,
                    body: {
                      text: input.title,
                      blocks: [
                        {
                          type: "header",
                          text: { type: "plain_text", text: input.title.slice(0, 150), emoji: true },
                        },
                        {
                          type: "section",
                          text: { type: "mrkdwn", text: truncateForSlack(input.markdown) },
                        },
                        {
                          type: "context",
                          elements: [
                            {
                              type: "mrkdwn",
                              text:
                                `skill \`${s.slug}\`` +
                                (input.workItemId !== undefined
                                  ? ` · work item \`${input.workItemId}\``
                                  : ""),
                            },
                          ],
                        },
                      ],
                    },
                    evidenceIds: [],
                  },
                  { channel: "slack", target: deps.slackChannel },
                );
                return {
                  sent: record.status === "sent",
                  ...(record.detail !== undefined ? { detail: record.detail } : {}),
                  deliveryRecordId: record.id,
                };
              },
            },
          }
        : {}),
      ...(deps.complete !== undefined ? { complete: deps.complete } : {}),
    };
  }

  return {
    async invoke(s, trigger, input, actor, now): Promise<SkillRunRecord> {
      const runId = newUlid();
      const startedAt = nowIso();
      const runNow = (now ?? new Date()).toISOString();
      await db.withTx(async (tx) => {
        await txSql(tx)`
          insert into skills.skill_runs
            (id, tenant_id, skill_id, version_id, trigger, input, status, started_at, created_at, updated_at)
          values
            (${runId}, ${s.tenantId}, ${s.skillId}, ${s.versionId}, ${trigger},
             ${JSON.stringify(input)}::text::jsonb, 'running', ${startedAt}, ${startedAt}, ${startedAt})`;
        await spine.append(tx, {
          tenantId: s.tenantId,
          topic: "skill.run.started",
          subjectRefs: [
            { kind: "skill", id: s.skillId },
            { kind: "skill_version", id: s.versionId },
          ],
          actor,
          payload: { slug: s.slug, trigger },
        });
      });

      let status: "succeeded" | "failed";
      let result: unknown;
      let error: string | undefined;
      const registration = runtime.resolve(s.slug);
      if (registration === undefined) {
        // Registry says active, but this server build never registered the
        // slug — an honest failed run, never a silent skip.
        status = "failed";
        error = `skill '${s.slug}' is active in the registry but not registered in this server build`;
      } else {
        try {
          result = await registration.run(input, buildContext(s, runNow, actor));
          status = "succeeded";
        } catch (err) {
          status = "failed";
          error = err instanceof Error ? err.message : String(err);
        }
      }

      const finishedAt = nowIso();
      await db.withTx(async (tx) => {
        await txSql(tx)`
          update skills.skill_runs
          set status = ${status},
              result = ${result === undefined ? null : JSON.stringify(result)}::text::jsonb,
              error = ${error ?? null},
              finished_at = ${finishedAt}, updated_at = ${finishedAt}
          where id = ${runId}`;
        await spine.append(tx, {
          tenantId: s.tenantId,
          topic: "skill.run.finished",
          subjectRefs: [
            { kind: "skill", id: s.skillId },
            { kind: "skill_version", id: s.versionId },
          ],
          actor,
          ...(status === "failed" ? { severity: "warning" as const } : {}),
          payload: { slug: s.slug, trigger, status },
        });
      });

      const rows: Parameters<typeof rowToRunRecord>[0][] = await db.sql`
        select * from skills.skill_runs where id = ${runId}`;
      return rowToRunRecord(rows[0]!);
    },
  };
}

// ── the schedule tick source ────────────────────────────────────────────────

export interface ScheduleTickDeps {
  /** Active skills across all tenants with their manifests (injectable for tests). */
  listActive(): Promise<ActiveSkillRef[]>;
  invoker: SkillInvoker;
}

/** UTC-minute key for the per-(skill, minute) firing dedupe. */
export function minuteKey(now: Date): string {
  return now.toISOString().slice(0, 16);
}

/**
 * The clock TickSource (id "skills.schedule"): cron-match each active
 * skill's manifest.triggers.schedule against the tick minute; fire at most
 * once per (skill, UTC minute) — the agents-heartbeat in-memory dedupe
 * pattern (ticks can arrive more than once inside a minute).
 */
export function createSkillScheduleTickSource(deps: ScheduleTickDeps): TickSource {
  const lastFiredMinute = new Map<string, string>();
  return {
    id: "skills.schedule",
    async tick(now: Date): Promise<void> {
      const minute = minuteKey(now);
      const active = await deps.listActive();
      for (const skill of active) {
        const schedule = skill.manifest.triggers?.schedule;
        if (schedule === undefined) continue;
        if (!cronMatches(schedule, now)) continue;
        if (lastFiredMinute.get(skill.skillId) === minute) continue;
        lastFiredMinute.set(skill.skillId, minute);
        await deps.invoker.invoke(skill, "schedule", {}, { kind: "tenant", id: skill.tenantId }, now);
      }
    },
  };
}

/** The production listActive: every tenant's active skills + manifests. */
export function listActiveSkills(db: Db): () => Promise<ActiveSkillRef[]> {
  interface Row {
    tenant_id: string;
    skill_id: string;
    version_id: string;
    slug: string;
    manifest: unknown;
  }
  return async () => {
    const rows: Row[] = await db.sql`
      select s.tenant_id, s.id as skill_id, v.id as version_id, s.slug, v.manifest
      from skills.skills s
      join skills.skill_versions v on v.id = s.current_version_id
      where s.status = 'active'
      order by s.id`;
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      skillId: r.skill_id,
      versionId: r.version_id,
      slug: r.slug,
      manifest: skillManifestSchema.parse(
        typeof r.manifest === "string" ? JSON.parse(r.manifest) : r.manifest,
      ),
    }));
  };
}

// ── the agent tool executor ─────────────────────────────────────────────────

export interface SkillToolExecutorDeps {
  db: Db;
  runtime: SkillRuntime;
  invoker: SkillInvoker;
}

/**
 * Executes broker-issued skill tools from inside agent runs. Unknown tool
 * names return undefined so the executor's dispatch can fall through to its
 * unknown-tool error (and, post-P13, the extra-tools map is consulted BEFORE
 * this). A registered skill that is not ACTIVE for the caller's tenant is an
 * is_error result, not an execution.
 */
export function createSkillToolExecutor(deps: SkillToolExecutorDeps): SkillToolExecutor {
  return {
    async tryExecuteTool(p: PrincipalContext, toolName: string, input: unknown) {
      const registration = deps.runtime.resolveTool(toolName);
      if (registration === undefined) return undefined;
      interface Row {
        id: string;
        current_version_id: string | null;
      }
      const rows: Row[] = await deps.db.sql`
        select id, current_version_id from skills.skills
        where tenant_id = ${p.tenantId} and slug = ${registration.slug} and status = 'active'`;
      const skill = rows[0];
      if (skill === undefined || skill.current_version_id === null) {
        return {
          result: `skill '${registration.slug}' is not active for this tenant — propose and activate it first`,
          isError: true,
        };
      }
      const run = await deps.invoker.invoke(
        {
          tenantId: p.tenantId,
          skillId: skill.id,
          versionId: skill.current_version_id,
          slug: registration.slug,
          manifest: registration.manifest,
        },
        "tool",
        (input ?? {}) as Record<string, unknown>,
        { kind: "principal", id: p.principalId },
      );
      return run.status === "succeeded"
        ? { result: JSON.stringify(run.result ?? null), isError: false }
        : { result: run.error ?? "skill run failed", isError: true };
    },
  };
}
