import { newUlid, nowIso } from "@lithis/core";
import type { Cost, Evidence, IsoDateTime, Ref, Ulid } from "@lithis/core";
import { txSql } from "../db";
import type { Db } from "../db";
import type { EventSpine } from "../spine";
import type { ContextStore } from "../context";
import type { AgentRunOutcome, WakeReason } from "./index";

/**
 * agents persistence — sessions, runs, per-attempt run results, immutable
 * evidence (the agents module's own tables), plus the transcript sink
 * (context-store blobs via the module's public putBlob — content-addressed,
 * deduped, provenance-stamped). Every state change appends its spine event in
 * the SAME transaction (transactional outbox).
 */

export function sha256Hex(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

export const ZERO_COST: Cost = { tokensIn: 0, tokensOut: 0, usd: 0 };

export function addCost(a: Cost, b: Cost): Cost {
  return { tokensIn: a.tokensIn + b.tokensIn, tokensOut: a.tokensOut + b.tokensOut, usd: a.usd + b.usd };
}

// ── transcripts ─────────────────────────────────────────────────────────────

export interface TranscriptStore {
  put(input: {
    tenantId: Ulid;
    principalId: Ulid;
    sessionId?: Ulid;
    transcript: unknown;
  }): Promise<Ulid>;
}

/** Transcript blobs ride the context store: application/json, llm-origin, internal trust. */
export function transcriptStoreFromContext(contextStore: ContextStore): TranscriptStore {
  return {
    async put(input): Promise<Ulid> {
      const bytes = new TextEncoder().encode(JSON.stringify(input.transcript, null, 2));
      const ref = await contextStore.putBlob(
        {
          tenantId: input.tenantId,
          mediaType: "application/json",
          origin: {
            by: { kind: "principal", id: input.principalId },
            method: "llm",
            trust: "internal",
            ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
            at: nowIso(),
          },
        },
        bytes,
      );
      return ref.id;
    },
  };
}

// ── evidence ────────────────────────────────────────────────────────────────

/**
 * A narrow, additive evidence-write surface for producers that are NOT agent
 * runs — deterministic checks and executors mint citable evidence too (see
 * Evidence.producedBy: "a principal or a run"). The agents module owns the
 * table, so the write goes through here rather than a cross-module reach.
 */
export interface EvidenceDraft {
  runId?: Ulid;
  /** A principal or a run — never a bare string. */
  producedBy: Ref;
  kind: Evidence["kind"];
  sources: Evidence["sources"];
  summary: string;
  blobIds?: Ulid[];
  /** Immutable content address; sha256Hex over the canonical payload. */
  contentHash: string;
  at: IsoDateTime;
}

export interface EvidenceWriter {
  /** Insert one immutable Evidence row; returns its id. */
  write(tenantId: Ulid, draft: EvidenceDraft): Promise<Ulid>;
}

export function createPgEvidenceWriter(db: Db): EvidenceWriter {
  return {
    async write(tenantId: Ulid, draft: EvidenceDraft): Promise<Ulid> {
      const id = newUlid();
      const at = nowIso();
      await db.sql`
        insert into agents.evidence
          (id, tenant_id, run_id, produced_by, kind, sources, summary, blob_ids,
           content_hash, at, created_at, updated_at)
        values
          (${id}, ${tenantId}, ${draft.runId ?? null},
           ${JSON.stringify(draft.producedBy)}::text::jsonb, ${draft.kind},
           ${JSON.stringify(draft.sources)}::text::jsonb, ${draft.summary},
           ${JSON.stringify(draft.blobIds ?? [])}::text::jsonb, ${draft.contentHash},
           ${draft.at}, ${at}, ${at})`;
      return id;
    },
  };
}

// ── sessions ────────────────────────────────────────────────────────────────

export interface OpenSession {
  id: Ulid;
  tenantId: Ulid;
  principalId: Ulid;
  startedAt: string;
}

export async function openLoopSession(
  db: Db,
  spine: EventSpine,
  input: { tenantId: Ulid; principalId: Ulid; reason: WakeReason },
): Promise<OpenSession> {
  const id = newUlid();
  const at = nowIso();
  await db.withTx(async (tx) => {
    await txSql(tx)`
      insert into agents.sessions
        (id, tenant_id, principal_id, kind, started_at, cost, created_at, updated_at)
      values
        (${id}, ${input.tenantId}, ${input.principalId}, 'loop', ${at},
         ${JSON.stringify(ZERO_COST)}::text::jsonb, ${at}, ${at})`;
    await spine.append(tx, {
      tenantId: input.tenantId,
      topic: "session.started",
      subjectRefs: [{ kind: "session", id }],
      actor: { kind: "principal", id: input.principalId },
      payload: { kind: "loop" },
    });
    await spine.append(tx, {
      tenantId: input.tenantId,
      topic: "agent.woke",
      subjectRefs: [
        { kind: "principal", id: input.principalId },
        { kind: "session", id },
      ],
      actor: { kind: "principal", id: input.principalId },
      payload: { reason: input.reason },
    });
  });
  return { id, tenantId: input.tenantId, principalId: input.principalId, startedAt: at };
}

export async function closeLoopSession(
  db: Db,
  spine: EventSpine,
  session: OpenSession,
  input: { cost: Cost; summary?: string; nextWakeAt?: string },
): Promise<void> {
  const at = nowIso();
  await db.withTx(async (tx) => {
    await txSql(tx)`
      update agents.sessions
      set ended_at = ${at}, cost = ${JSON.stringify(input.cost)}::text::jsonb,
          summary = ${input.summary ?? null}, updated_at = ${at}
      where id = ${session.id}`;
    await spine.append(tx, {
      tenantId: session.tenantId,
      topic: "session.ended",
      subjectRefs: [{ kind: "session", id: session.id }],
      actor: { kind: "principal", id: session.principalId },
      payload: {
        cost: input.cost,
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
      },
    });
    await spine.append(tx, {
      tenantId: session.tenantId,
      topic: "agent.slept",
      subjectRefs: [
        { kind: "principal", id: session.principalId },
        { kind: "session", id: session.id },
      ],
      actor: { kind: "principal", id: session.principalId },
      payload: input.nextWakeAt !== undefined ? { nextWakeAt: input.nextWakeAt } : {},
    });
  });
}

// ── runs ────────────────────────────────────────────────────────────────────

export interface StartedRun {
  id: Ulid;
  tenantId: Ulid;
  principalId: Ulid;
  sessionId: Ulid;
  workItemId?: Ulid;
  model: string;
}

export async function startRun(
  db: Db,
  spine: EventSpine,
  input: {
    tenantId: Ulid;
    principalId: Ulid;
    sessionId: Ulid;
    workItemId?: Ulid;
    model: string;
    cause: string;
  },
): Promise<StartedRun> {
  const id = newUlid();
  const at = nowIso();
  await db.withTx(async (tx) => {
    await txSql(tx)`
      insert into agents.runs
        (id, tenant_id, principal_id, session_id, work_item_id, model, trigger,
         status, cost, started_at, created_at, updated_at)
      values
        (${id}, ${input.tenantId}, ${input.principalId}, ${input.sessionId},
         ${input.workItemId ?? null}, ${input.model},
         ${JSON.stringify({ cause: input.cause })}::text::jsonb,
         'running', ${JSON.stringify(ZERO_COST)}::text::jsonb, ${at}, ${at}, ${at})`;
    await spine.append(tx, {
      tenantId: input.tenantId,
      topic: "run.started",
      subjectRefs: [
        { kind: "run", id },
        ...(input.workItemId !== undefined
          ? [{ kind: "work_item", id: input.workItemId } as const]
          : []),
      ],
      actor: { kind: "principal", id: input.principalId },
      payload: { model: input.model, triggerCause: input.cause },
    });
  });
  return {
    id,
    tenantId: input.tenantId,
    principalId: input.principalId,
    sessionId: input.sessionId,
    ...(input.workItemId !== undefined ? { workItemId: input.workItemId } : {}),
    model: input.model,
  };
}

/**
 * Persist a finished run: run row goes terminal, evidence drafts become
 * immutable rows, done-runs write a per-attempt RunResult (superseded-never-
 * overwritten — cascades that flip `superseded` are P8), and run.finished
 * rides the same transaction. `inputsHash` is sha256 over the brief's context
 * slice + work item ref — the rerun short-circuit input until briefs carry
 * explicit inputRefs.
 */
export async function finishRun(
  db: Db,
  spine: EventSpine,
  run: StartedRun,
  outcome: AgentRunOutcome,
  opts: { transcriptBlobId?: Ulid; inputsHash: string },
): Promise<void> {
  const at = nowIso();
  await db.withTx(async (tx) => {
    const sql = txSql(tx);
    await sql`
      update agents.runs
      set status = ${outcome.status}, cost = ${JSON.stringify(outcome.cost)}::text::jsonb,
          transcript_blob_id = ${opts.transcriptBlobId ?? null},
          ended_at = ${at}, updated_at = ${at}
      where id = ${run.id}`;

    const evidenceIds: Ulid[] = [];
    for (const draft of outcome.evidenceDrafts) {
      const evidenceId = newUlid();
      evidenceIds.push(evidenceId);
      await sql`
        insert into agents.evidence
          (id, tenant_id, run_id, produced_by, kind, sources, summary, blob_ids,
           content_hash, at, created_at, updated_at)
        values
          (${evidenceId}, ${run.tenantId}, ${run.id},
           ${JSON.stringify(draft.producedBy)}::text::jsonb, ${draft.kind},
           ${JSON.stringify(draft.sources)}::text::jsonb, ${draft.summary},
           ${JSON.stringify(draft.blobIds)}::text::jsonb, ${draft.contentHash},
           ${draft.at}, ${at}, ${at})`;
    }

    if (run.workItemId !== undefined && outcome.status === "done") {
      const attemptRows: { n: bigint | number }[] = await sql`
        select count(*) as n from agents.run_results
        where tenant_id = ${run.tenantId} and work_item_id = ${run.workItemId}`;
      const attempt = Number(attemptRows[0]!.n);
      await sql`
        insert into agents.run_results
          (id, tenant_id, run_id, work_item_id, attempt, result_json, summary,
           evidence_ids, input_refs, inputs_hash, superseded, created_at, updated_at)
        values
          (${newUlid()}, ${run.tenantId}, ${run.id}, ${run.workItemId}, ${attempt},
           ${outcome.resultJson === undefined ? null : JSON.stringify(outcome.resultJson)}::text::jsonb,
           ${outcome.summary ?? `run ${run.id} done`},
           ${JSON.stringify(evidenceIds)}::text::jsonb,
           ${JSON.stringify([{ kind: "work_item", id: run.workItemId }])}::text::jsonb,
           ${opts.inputsHash}, false, ${at}, ${at})`;
    }

    await spine.append(tx, {
      tenantId: run.tenantId,
      topic: "run.finished",
      subjectRefs: [
        { kind: "run", id: run.id },
        ...(run.workItemId !== undefined
          ? [{ kind: "work_item", id: run.workItemId } as const]
          : []),
      ],
      actor: { kind: "principal", id: run.principalId },
      payload: { status: outcome.status, cost: outcome.cost },
    });
  });
}

/** Sum of run cost (usd) for a principal since `sinceIso` — the daily-budget projection. */
export async function sumRunUsdSince(
  db: Db,
  tenantId: Ulid,
  principalId: Ulid,
  sinceIso: string,
): Promise<number> {
  const rows: { usd: string | number | null }[] = await db.sql`
    select coalesce(sum((cost ->> 'usd')::numeric), 0) as usd
    from agents.runs
    where tenant_id = ${tenantId} and principal_id = ${principalId}
      and started_at >= ${sinceIso}::timestamptz`;
  return Number(rows[0]!.usd ?? 0);
}
