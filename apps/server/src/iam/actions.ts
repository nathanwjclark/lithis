import { z } from "zod";
import {
  actionIntentSchema,
  capabilitySchema,
  newUlid,
  nowIso,
  refSchema,
  ulidSchema,
} from "@lithis/core";
import type {
  ActionIntent,
  Capability,
  Event,
  HumanRequest,
  Ref,
  Ulid,
} from "@lithis/core";
import { txSql } from "../db";
import type { Db } from "../db";
import type { EventSpine } from "../spine";
import type { EvidenceWriter } from "../agents";
import { sha256Hex } from "../agents";

/**
 * ActionIntent batches — the choke point every externally-visible action goes
 * through. N intents share a `batchId`, one HumanRequest{action_batch} carries
 * per-item detail, the human returns per-item verdicts ("approve 38 of 40,
 * edit 2"), and only approved/modified items execute — each one recording an
 * immutable Evidence receipt whose ref lands on the intent.
 *
 * Everything here is honest about failure: a failed execution is `failed` with
 * a receipt explaining why, never a quiet retry and never a success.
 *
 * Dependencies arrive as narrow injected ports (the sentinel precedent):
 * `ActionGate` is structurally satisfied by the humangate module's HumanGate,
 * and `ActionExecutor` by the connector-backed executor in ./executor.ts —
 * iam imports neither module's internals.
 */

// ── the pinned payload for HumanRequest{subjectKind:'action_batch'} ─────────

export const actionBatchItemSchema = z.object({
  intentId: ulidSchema,
  capability: capabilitySchema,
  /** What this item will actually do, in one line a reviewer can judge. */
  summary: z.string().min(1),
  params: z.unknown().optional(),
  /** The external counterpart (an Entity — the person being contacted). */
  counterpartRef: refSchema.optional(),
});
export type ActionBatchItem = z.infer<typeof actionBatchItemSchema>;

export const actionBatchPayloadSchema = z.object({
  batchId: ulidSchema,
  proposedBy: refSchema,
  /** The principal whose credentials/capabilities perform the actions. */
  principalId: ulidSchema,
  items: z.array(actionBatchItemSchema).min(1),
});
export type ActionBatchPayload = z.infer<typeof actionBatchPayloadSchema>;

// ── ports ───────────────────────────────────────────────────────────────────

/** The human-gate slice iam needs (HumanGate satisfies it structurally). */
export interface ActionGate {
  request(
    r: Omit<HumanRequest, "id" | "createdAt" | "updatedAt" | "state" | "resolution">,
  ): Promise<HumanRequest>;
  get(id: Ulid, tenantId: Ulid): Promise<HumanRequest | undefined>;
}

export interface ActionExecutionResult {
  ok: boolean;
  /** Upstream system's id for what was created/sent, when there is one. */
  externalId?: string;
  detail?: string;
  /** Evidence blobs the executor already persisted (e.g. a page capture). */
  blobIds?: Ulid[];
}

/** How an approved intent actually reaches the outside world. */
export interface ActionExecutor {
  execute(input: { tenantId: Ulid; intent: ActionIntent }): Promise<ActionExecutionResult>;
}

// ── service surface ─────────────────────────────────────────────────────────

export interface NewActionIntent {
  capability: Capability;
  /** One-line description a reviewer reads on the card. */
  summary: string;
  params?: unknown;
  counterpartRef?: Ref;
}

export interface ProposeBatchInput {
  tenantId: Ulid;
  /** The principal that will perform the actions once approved. */
  principalId: Ulid;
  /** Who is asking (agent, skill principal, human). */
  requestedBy: Ref;
  /** The batch-level summary rendered on the approval card. */
  summary: string;
  items: NewActionIntent[];
  assignee?: Ref | string;
  channelPrefs?: ("portal" | "slack" | "teams" | "email")[];
  slaHours?: number;
  evidenceIds?: Ulid[];
}

export interface ProposeBatchResult {
  batchId: Ulid;
  humanRequestId: Ulid;
  intentIds: Ulid[];
}

export interface BatchResolution {
  batchId: Ulid;
  approved: number;
  denied: number;
  modified: number;
}

export interface BatchExecutionSummary {
  batchId: Ulid;
  executed: number;
  failed: number;
  skipped: number;
}

export interface ActionIntentService {
  /** Propose N intents as ONE gated batch; nothing executes until a human says so. */
  proposeBatch(input: ProposeBatchInput): Promise<ProposeBatchResult>;
  listBatch(tenantId: Ulid, batchId: Ulid): Promise<ActionIntent[]>;
  get(tenantId: Ulid, intentId: Ulid): Promise<ActionIntent | undefined>;
  /** Spine consumer for humangate.resolved on action_batch subjects. */
  handleResolved(event: Event): Promise<void>;
  /** Execute the batch's approved/modified items. Idempotent per item. */
  executeBatch(tenantId: Ulid, batchId: Ulid): Promise<BatchExecutionSummary>;
}

export interface ActionIntentDeps {
  db: Db;
  spine: EventSpine;
  gate: ActionGate;
  evidence: EvidenceWriter;
  /** Absent → approved batches are marked but never executed (config degrade). */
  executor?: ActionExecutor;
  /** Execute immediately when a batch is approved (default true). */
  executeOnResolve?: boolean;
}

// ── row mapping ─────────────────────────────────────────────────────────────

interface ActionIntentRow {
  id: string;
  tenant_id: string;
  batch_id: string | null;
  principal_id: string;
  capability: string;
  params: unknown;
  counterpart_ref: unknown;
  status: string;
  receipt_ref: unknown;
  human_request_id: string | null;
  detail: string | null;
  external_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Bun's SQL client returns jsonb columns as JSON text — parse before zod. */
function fromJsonb(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function rowToIntent(row: ActionIntentRow): ActionIntent {
  return actionIntentSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    ...(row.batch_id !== null ? { batchId: row.batch_id } : {}),
    principalId: row.principal_id,
    capability: row.capability,
    params: fromJsonb(row.params) ?? undefined,
    ...(row.counterpart_ref !== null ? { counterpartRef: fromJsonb(row.counterpart_ref) } : {}),
    status: row.status,
    ...(row.receipt_ref !== null ? { receiptRef: fromJsonb(row.receipt_ref) } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

/** Statuses that release an intent for execution. */
const EXECUTABLE = new Set(["approved", "modified"]);

export function createActionIntentService(deps: ActionIntentDeps): ActionIntentService {
  const { db, spine, gate, evidence } = deps;
  const executeOnResolve = deps.executeOnResolve ?? true;

  async function loadBatch(tenantId: Ulid, batchId: Ulid): Promise<ActionIntent[]> {
    const rows: ActionIntentRow[] = await db.sql`
      select * from iam.action_intents
      where tenant_id = ${tenantId} and batch_id = ${batchId}
      order by id`;
    return rows.map(rowToIntent);
  }

  /** Mint the receipt Evidence row for one execution attempt (ok or not). */
  async function recordReceipt(
    intent: ActionIntent,
    result: ActionExecutionResult,
    at: string,
  ): Promise<Ulid> {
    const blobIds = result.blobIds ?? [];
    return evidence.write(intent.tenantId, {
      producedBy: { kind: "principal", id: intent.principalId },
      kind: blobIds.length > 0 ? "page_capture" : "record",
      sources: [
        {
          ref: { kind: "action_intent", id: intent.id },
          whyRelevant:
            `Receipt for the ${result.ok ? "executed" : "failed"} action ` +
            `'${intent.capability}' approved in batch ${intent.batchId ?? "(none)"}.`,
          ...(result.detail !== undefined ? { excerpt: result.detail } : {}),
        },
        ...(intent.counterpartRef !== undefined
          ? [
              {
                ref: intent.counterpartRef,
                whyRelevant: "The external counterpart this action was directed at.",
              },
            ]
          : []),
      ],
      summary:
        `${result.ok ? "Executed" : "FAILED"} ${intent.capability}` +
        `${result.externalId !== undefined ? ` (${result.externalId})` : ""}` +
        `${result.detail !== undefined ? ` — ${result.detail}` : ""}`,
      blobIds,
      contentHash: sha256Hex(
        JSON.stringify({
          intentId: intent.id,
          capability: intent.capability,
          ok: result.ok,
          externalId: result.externalId ?? null,
          detail: result.detail ?? null,
          blobIds,
          at,
        }),
      ),
      at,
    });
  }

  async function executeBatch(tenantId: Ulid, batchId: Ulid): Promise<BatchExecutionSummary> {
    const intents = await loadBatch(tenantId, batchId);
    const summary: BatchExecutionSummary = { batchId, executed: 0, failed: 0, skipped: 0 };
    const executor = deps.executor;

    for (const intent of intents) {
      if (!EXECUTABLE.has(intent.status)) {
        summary.skipped += 1;
        continue;
      }
      if (executor === undefined) {
        // Honest degrade: nothing is marked executed without an executor.
        throw new Error(
          `action batch ${batchId} has approved items but this server has no action executor ` +
            `wired (connector runtime + connection registry) — nothing was executed`,
        );
      }
      // Claim the item so a concurrent worker cannot double-send.
      const claimed: { id: string }[] = await db.sql`
        update iam.action_intents
        set status = 'executing', updated_at = ${nowIso()}
        where id = ${intent.id} and tenant_id = ${tenantId} and status = ${intent.status}
        returning id`;
      if (claimed.length === 0) {
        summary.skipped += 1;
        continue;
      }

      let result: ActionExecutionResult;
      try {
        result = await executor.execute({ tenantId, intent });
      } catch (err) {
        result = { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }

      const at = nowIso();
      const receiptId = await recordReceipt(intent, result, at);
      const status = result.ok ? "executed" : "failed";
      await db.withTx(async (tx) => {
        await txSql(tx)`
          update iam.action_intents
          set status = ${status},
              receipt_ref = ${JSON.stringify({ kind: "evidence", id: receiptId })}::text::jsonb,
              detail = ${result.detail ?? null},
              external_id = ${result.externalId ?? null},
              updated_at = ${at}
          where id = ${intent.id}`;
        await spine.append(tx, {
          tenantId,
          topic: result.ok ? "iam.action_intent.executed" : "iam.action_intent.failed",
          subjectRefs: [
            { kind: "action_intent", id: intent.id },
            { kind: "evidence", id: receiptId },
          ],
          actor: { kind: "principal", id: intent.principalId },
          ...(result.ok ? {} : { severity: "warning" as const }),
          payload: result.ok
            ? {
                ...(intent.batchId !== undefined ? { batchId: intent.batchId } : {}),
                capability: intent.capability,
                ...(result.externalId !== undefined ? { externalId: result.externalId } : {}),
              }
            : {
                ...(intent.batchId !== undefined ? { batchId: intent.batchId } : {}),
                capability: intent.capability,
                error: result.detail ?? "execution failed without a detail",
              },
        });
      });
      if (result.ok) summary.executed += 1;
      else summary.failed += 1;
    }
    return summary;
  }

  return {
    async proposeBatch(input: ProposeBatchInput): Promise<ProposeBatchResult> {
      if (input.items.length === 0) {
        throw new Error("cannot propose an empty action batch");
      }
      const batchId = newUlid();
      const at = nowIso();
      const items: ActionBatchItem[] = input.items.map((item) =>
        actionBatchItemSchema.parse({
          intentId: newUlid(),
          capability: item.capability,
          summary: item.summary,
          ...(item.params !== undefined ? { params: item.params } : {}),
          ...(item.counterpartRef !== undefined ? { counterpartRef: item.counterpartRef } : {}),
        }),
      );
      const payload = actionBatchPayloadSchema.parse({
        batchId,
        proposedBy: input.requestedBy,
        principalId: input.principalId,
        items,
      });

      await db.withTx(async (tx) => {
        const sql = txSql(tx);
        for (const item of items) {
          await sql`
            insert into iam.action_intents
              (id, tenant_id, batch_id, principal_id, capability, params, counterpart_ref,
               status, receipt_ref, created_at, updated_at)
            values
              (${item.intentId}, ${input.tenantId}, ${batchId}, ${input.principalId},
               ${item.capability},
               ${item.params === undefined ? null : JSON.stringify(item.params)}::text::jsonb,
               ${item.counterpartRef === undefined ? null : JSON.stringify(item.counterpartRef)}::text::jsonb,
               'proposed', null, ${at}, ${at})`;
        }
        await spine.append(tx, {
          tenantId: input.tenantId,
          topic: "iam.action_batch.proposed",
          subjectRefs: [{ kind: "action_batch", id: batchId }],
          actor: input.requestedBy,
          payload: {
            batchId,
            itemCount: items.length,
            capabilities: [...new Set(items.map((i) => i.capability))],
          },
        });
      });

      // The gate write runs in its own transaction (humangate owns its outbox);
      // the back-link onto the intents lands right after.
      const request = await gate.request({
        tenantId: input.tenantId,
        kind: "approval",
        subjectKind: "action_batch",
        subjectRef: { kind: "action_batch", id: batchId },
        payload,
        evidenceIds: input.evidenceIds ?? [],
        summary: input.summary,
        routing: {
          assignee: input.assignee ?? "tenant-admin",
          channelPrefs: input.channelPrefs ?? ["portal"],
          ...(input.slaHours !== undefined ? { slaHours: input.slaHours } : {}),
          escalationPath: [],
          followUpCount: 0,
        },
        requestedBy: input.requestedBy,
      });
      await db.sql`
        update iam.action_intents
        set human_request_id = ${request.id}, updated_at = ${nowIso()}
        where tenant_id = ${input.tenantId} and batch_id = ${batchId}`;

      return { batchId, humanRequestId: request.id, intentIds: items.map((i) => i.intentId) };
    },

    listBatch: loadBatch,

    async get(tenantId: Ulid, intentId: Ulid): Promise<ActionIntent | undefined> {
      const rows: ActionIntentRow[] = await db.sql`
        select * from iam.action_intents where tenant_id = ${tenantId} and id = ${intentId}`;
      const row = rows[0];
      return row === undefined ? undefined : rowToIntent(row);
    },

    async handleResolved(event: Event): Promise<void> {
      if (event.topic !== "humangate.resolved") return;
      const batchRef = event.subjectRefs.find((r) => r.kind === "action_batch");
      const requestRef = event.subjectRefs.find((r) => r.kind === "human_request");
      if (batchRef === undefined || requestRef === undefined) return;

      const request = await gate.get(requestRef.id, event.tenantId);
      if (request === undefined || request.subjectKind !== "action_batch") return;
      const resolution = request.resolution;
      if (resolution === undefined) return;

      const intents = await loadBatch(event.tenantId, batchRef.id);
      const perItem = new Map(
        (resolution.perItem ?? []).map((v) => [v.intentId, v] as const),
      );
      // No per-item verdicts → the batch-level verdict applies to every item.
      const fallback: "approved" | "denied" | "modified" | undefined =
        resolution.verdict === "approved" || resolution.verdict === "denied" ||
        resolution.verdict === "modified"
          ? resolution.verdict
          : undefined;

      const counts = { approved: 0, denied: 0, modified: 0 };
      const at = nowIso();
      await db.withTx(async (tx) => {
        const sql = txSql(tx);
        for (const intent of intents) {
          if (intent.status !== "proposed") continue; // at-least-once redelivery is safe
          const verdict = perItem.get(intent.id)?.verdict ?? fallback;
          if (verdict === undefined) continue;
          counts[verdict] += 1;
          const modification = perItem.get(intent.id)?.modification;
          await sql`
            update iam.action_intents
            set status = ${verdict},
                params = coalesce(
                  ${modification === undefined ? null : JSON.stringify(modification)}::text::jsonb,
                  params),
                updated_at = ${at}
            where id = ${intent.id}`;
        }
        await spine.append(tx, {
          tenantId: event.tenantId,
          topic: "iam.action_batch.resolved",
          subjectRefs: [batchRef, requestRef],
          actor: resolution.by,
          payload: { batchId: batchRef.id, ...counts },
        });
      });

      if (executeOnResolve && counts.approved + counts.modified > 0) {
        await executeBatch(event.tenantId, batchRef.id);
      }
    },

    executeBatch,
  };
}
