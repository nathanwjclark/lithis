import {
  cascadePlanSchema,
  newUlid,
  nowIso,
  processRunSchema,
  processTemplateSchema,
  refSchema,
  watchRuleSchema,
} from "@lithis/core";
import type {
  CascadePlan,
  Event,
  InvalidationCause,
  NodeDef,
  PrincipalContext,
  ProcessRun,
  ProcessTemplate,
  Ref,
  Ulid,
  WatchRule,
  WorkItem,
} from "@lithis/core";
import { stub } from "@lithis/stubkit";
import { txSql } from "../db";
import type { Db, DbTx } from "../db";
import type { HumanGate, HumanRequestId, NewHumanRequest } from "../humangate";
import type { EventSpine } from "../spine";
import type { WorkQueue } from "../work";
import {
  bindWatchRules,
  matchesWatchRule,
  topoOrder,
  walkDependents,
} from "./invalidator";
import type { BoundRule, KeyEdge } from "./invalidator";
import type {
  DynamicSpec,
  GraphDelta,
  InstantiateOptions,
  NewProcessTemplate,
  ProcessEngine,
  ProcessEngineDeps,
  RunResultPort,
  TemplateRef,
} from "./index";

/**
 * The Postgres process engine. Nodes ARE WorkItems (kind process_node) opened
 * through the real work queue with depends_on edges — there is no second
 * state machine here; processes owns only templates, runs, instance-bound
 * WatchRules, and parked pending actions. Every state change rides the
 * transactional outbox.
 *
 * THE INVALIDATOR: pure code, the ONLY writer of `stale`. planInvalidation is
 * a dry run always; over-width plans park in processes.pending_actions behind
 * a HumanRequest{cascade_plan}; executeInvalidation supersedes granted gates
 * (humangate.supersedeForSubject), supersedes RunResults (through the
 * RunResultPort seam — real store lands with P7-agents), stales done /
 * awaiting_approval nodes, demotes ready dependents, and revokes in-flight
 * leases (the holder's next lease op throws LeaseLostError; P7 maps that to
 * an AbortSignal).
 */

const DEFAULT_AUTO_EXECUTE_MAX_WIDTH = 3;

/** Topics the engine's spine subscription (and handleEvent) reacts to. */
export const PROCESS_ENGINE_TOPICS = [
  "context.doc.created",
  "context.doc.distilled",
  "humangate.resolved",
] as const;

export class ProcessRunNotFoundError extends Error {
  constructor(id: string) {
    super(`process run ${id} not found`);
    this.name = "ProcessRunNotFoundError";
  }
}

export class ProcessTemplateNotFoundError extends Error {
  constructor(detail: string) {
    super(`process template not found: ${detail}`);
    this.name = "ProcessTemplateNotFoundError";
  }
}

export class ProcessNodeNotFoundError extends Error {
  constructor(runId: string, nodeKey: string) {
    super(`process run ${runId} has no node '${nodeKey}'`);
    this.name = "ProcessNodeNotFoundError";
  }
}

/** A GraphDelta the run's changePolicy (or graph shape) does not allow. */
export class GraphChangeRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphChangeRejectedError";
  }
}

/**
 * RunResult supersession seam: agents.run_results is the agents module's
 * table (P7-agents, in flight) — the Invalidator flips results through this
 * port instead of reaching across module tables. P7 wires the real store.
 */
export const stubRunResultPort: RunResultPort = {
  supersede: stub<RunResultPort["supersede"]>(
    "server.processes.results.supersede",
    "LITHIS-STUB: RunResult supersession awaits the P7-agents result store (agents.run_results is agents-owned; wire its RunResultPort here)",
  ),
};

/** interpret-mode WatchRules need one LLM assertion run — P7 territory. */
export const stubInterpretAssertion = stub<(rule: WatchRule, e: Event) => never>(
  "server.processes.watch.interpret",
  "LITHIS-STUB: interpret-mode WatchRule matching (one auditable LLM assertion run, confidence-gated to HumanRequest{question}) not implemented — bind deterministic rules",
);

interface RunRow {
  id: string;
  tenant_id: string;
  template_ref: unknown;
  subject_ref: unknown;
  status: string;
  graph_revision: number;
  bindings: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TemplateRow {
  id: string;
  tenant_id: string;
  slug: string;
  version: string;
  mode: string;
  nodes: unknown;
  edges: unknown;
  change_policy: unknown;
  approval_request_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface WatchRuleRow {
  id: string;
  tenant_id: string;
  process_run_id: string;
  node_key: string;
  match: unknown;
  mode: string;
}

interface PendingActionRow {
  id: string;
  tenant_id: string;
  process_run_id: string;
  human_request_id: string;
  kind: string;
  payload: unknown;
}

/** Bun's SQL client returns jsonb columns as JSON text — parse before zod. */
function fromJsonb(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToRun(row: RunRow): ProcessRun {
  const templateRef = fromJsonb(row.template_ref);
  return processRunSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    ...(templateRef !== null && templateRef !== undefined ? { templateRef } : {}),
    subjectRef: fromJsonb(row.subject_ref),
    status: row.status,
    graphRevision: row.graph_revision,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

function rowToTemplate(row: TemplateRow): ProcessTemplate {
  return processTemplateSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    slug: row.slug,
    version: row.version,
    mode: row.mode,
    nodes: fromJsonb(row.nodes),
    edges: fromJsonb(row.edges),
    changePolicy: fromJsonb(row.change_policy),
    ...(row.approval_request_id !== null ? { approvalRequestId: row.approval_request_id } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

function rowToWatchRule(row: WatchRuleRow): WatchRule {
  return watchRuleSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    processRunId: row.process_run_id,
    nodeKey: row.node_key,
    match: fromJsonb(row.match),
    mode: row.mode,
  });
}

function payloadField(e: Event, field: string): unknown {
  const payload = e.payload as Record<string, unknown> | undefined;
  return payload?.[field];
}

function subjectOfKind(e: Event, kind: Ref["kind"]): Ref | undefined {
  return e.subjectRefs.find((r) => r.kind === kind);
}

export function createPgProcessEngine(deps: ProcessEngineDeps): ProcessEngine {
  const { db, spine, work, gate } = deps;
  const results = deps.results ?? stubRunResultPort;
  const autoExecuteMaxWidth = deps.autoExecuteMaxWidth ?? DEFAULT_AUTO_EXECUTE_MAX_WIDTH;

  async function getRun(id: Ulid): Promise<ProcessRun | undefined> {
    const rows: RunRow[] = await db.sql`select * from processes.process_runs where id = ${id}`;
    return rows[0] === undefined ? undefined : rowToRun(rows[0]);
  }

  async function mustRun(id: Ulid): Promise<ProcessRun> {
    const run = await getRun(id);
    if (run === undefined) throw new ProcessRunNotFoundError(id);
    return run;
  }

  async function runBindings(id: Ulid): Promise<Record<string, Ref>> {
    const rows: { bindings: unknown }[] = await db.sql`
      select bindings from processes.process_runs where id = ${id}`;
    const raw = fromJsonb(rows[0]?.bindings) ?? {};
    const out: Record<string, Ref> = {};
    for (const [name, ref] of Object.entries(raw as Record<string, unknown>)) {
      out[name] = refSchema.parse(ref);
    }
    return out;
  }

  /** The run's graph as node-key structures (items carry their WorkItem). */
  async function keyGraph(
    run: ProcessRun,
  ): Promise<{ byKey: Map<string, WorkItem>; edges: KeyEdge[] }> {
    const graph = await work.graphForProcessRun(run.tenantId, run.id);
    const keyById = new Map<string, string>();
    const byKey = new Map<string, WorkItem>();
    for (const item of graph.items) {
      if (item.nodeKey === undefined || item.status === "cancelled") continue;
      keyById.set(item.id, item.nodeKey);
      byKey.set(item.nodeKey, item);
    }
    const edges: KeyEdge[] = [];
    for (const e of graph.edges) {
      if (e.verb !== "depends_on") continue;
      const from = keyById.get(e.fromId);
      const to = keyById.get(e.toId);
      if (from !== undefined && to !== undefined) edges.push({ from, to });
    }
    return { byKey, edges };
  }

  async function insertWatchRules(
    tx: DbTx,
    tenantId: Ulid,
    processRunId: Ulid,
    bound: BoundRule[],
  ): Promise<void> {
    const at = nowIso();
    for (const b of bound) {
      const rule = watchRuleSchema.parse({
        id: newUlid(),
        tenantId,
        processRunId,
        nodeKey: b.nodeKey,
        match: b.match,
        mode: b.mode,
      });
      await txSql(tx)`
        insert into processes.watch_rules
          (id, tenant_id, process_run_id, node_key, match, mode, created_at, updated_at)
        values
          (${rule.id}, ${rule.tenantId}, ${rule.processRunId}, ${rule.nodeKey},
           ${JSON.stringify(rule.match)}::text::jsonb, ${rule.mode}, ${at}, ${at})`;
    }
  }

  /**
   * Open node WorkItems in topological order, wiring depends_on edges through
   * the queue. `existingByKey` lets graph changes hang new nodes off already
   * open items.
   */
  async function openNodeItems(
    run: Pick<ProcessRun, "id" | "tenantId" | "subjectRef">,
    nodes: NodeDef[],
    edges: KeyEdge[],
    owner: Ulid,
    existingByKey: Map<string, WorkItem> = new Map(),
  ): Promise<Map<string, Ulid>> {
    const idByKey = new Map<string, Ulid>(
      [...existingByKey.entries()].map(([k, item]) => [k, item.id]),
    );
    const newKeys = nodes.map((n) => n.key);
    const amongNew = edges.filter((e) => newKeys.includes(e.from));
    const order = topoOrder(newKeys, amongNew.filter((e) => newKeys.includes(e.to)));
    const byKey = new Map(nodes.map((n) => [n.key, n]));
    for (const key of order) {
      const node = byKey.get(key)!;
      const dependsOn = amongNew
        .filter((e) => e.from === key)
        .map((e) => {
          const upstreamId = idByKey.get(e.to);
          if (upstreamId === undefined) throw new ProcessNodeNotFoundError(run.id, e.to);
          return upstreamId;
        });
      const id = await work.open(
        {
          tenantId: run.tenantId,
          kind: "process_node",
          title: node.title,
          body: node.instructions,
          ownerPrincipalId: owner,
          priority: 0.5,
          processRunId: run.id,
          nodeKey: node.key,
          sourceRefs: [run.subjectRef, { kind: "process_run", id: run.id }],
        },
        { dependsOn },
      );
      idByKey.set(key, id);
    }
    return idByKey;
  }

  async function loadPendingAction(humanRequestId: Ulid): Promise<PendingActionRow | undefined> {
    const rows: PendingActionRow[] = await db.sql`
      select * from processes.pending_actions where human_request_id = ${humanRequestId}`;
    return rows[0];
  }

  async function parkPendingAction(
    run: ProcessRun,
    kind: "cascade_plan" | "graph_change",
    payload: unknown,
    request: Omit<NewHumanRequest, "tenantId" | "subjectRef" | "payload">,
  ): Promise<HumanRequestId> {
    const created = await gate.request({
      ...request,
      tenantId: run.tenantId,
      subjectRef: { kind: "process_run", id: run.id },
      payload,
    });
    const at = nowIso();
    await db.sql`
      insert into processes.pending_actions
        (id, tenant_id, process_run_id, human_request_id, kind, payload, created_at, updated_at)
      values
        (${newUlid()}, ${run.tenantId}, ${run.id}, ${created.id}, ${kind},
         ${JSON.stringify(payload)}::text::jsonb, ${at}, ${at})`;
    return created.id;
  }

  async function applyGraphChange(run: ProcessRun, delta: GraphDelta): Promise<void> {
    const { byKey } = await keyGraph(run);
    const owner = [...byKey.values()][0]?.ownerPrincipalId;
    const addNodes = delta.addNodes ?? [];
    const addEdges = delta.addEdges ?? [];
    const skipNodes = delta.skipNodes ?? [];
    // Re-validate against the live graph (keys may have changed since propose).
    for (const n of addNodes) {
      if (byKey.has(n.key)) throw new GraphChangeRejectedError(`node '${n.key}' already exists`);
    }
    const newKeys = new Set(addNodes.map((n) => n.key));
    for (const e of addEdges) {
      if (!newKeys.has(e.from)) {
        throw new GraphChangeRejectedError(
          `edge '${e.from}'→'${e.to}': only edges FROM newly added nodes are supported (adding upstreams onto an existing node would silently invalidate it)`,
        );
      }
      if (!newKeys.has(e.to) && !byKey.has(e.to)) {
        throw new GraphChangeRejectedError(`edge '${e.from}'→'${e.to}': unknown upstream '${e.to}'`);
      }
    }
    const cancelled: string[] = [];
    for (const key of skipNodes) {
      const item = byKey.get(key);
      if (item === undefined) throw new GraphChangeRejectedError(`skip: unknown node '${key}'`);
      if (item.status === "done") {
        throw new GraphChangeRejectedError(`skip: node '${key}' is already done`);
      }
      await work.cancel(item.id, { kind: "tenant", id: run.tenantId });
      cancelled.push(key);
    }
    if (addNodes.length > 0 && owner === undefined) {
      throw new GraphChangeRejectedError("run has no live nodes to inherit an owner from");
    }
    if (addNodes.length > 0) {
      await openNodeItems(run, addNodes, addEdges, owner!, byKey);
    }
    const bindings = await runBindings(run.id);
    const revision = run.graphRevision + 1;
    await db.withTx(async (tx) => {
      await insertWatchRules(tx, run.tenantId, run.id, bindWatchRules(addNodes, bindings));
      await txSql(tx)`
        update processes.process_runs
        set graph_revision = ${revision}, updated_at = ${nowIso()}
        where id = ${run.id}`;
      await spine.append(tx, {
        tenantId: run.tenantId,
        topic: "process.graph.changed",
        subjectRefs: [{ kind: "process_run", id: run.id }],
        actor: { kind: "tenant", id: run.tenantId },
        payload: {
          graphRevision: revision,
          addedNodeKeys: addNodes.map((n) => n.key),
          cancelledNodeKeys: cancelled,
        },
      });
    });
  }

  /** A resolved HumanRequest may settle a parked cascade plan / graph change. */
  async function settlePendingAction(e: Event): Promise<void> {
    const hrRef = subjectOfKind(e, "human_request");
    if (hrRef === undefined) return;
    const hold = await loadPendingAction(hrRef.id);
    if (hold === undefined || hold.tenant_id !== e.tenantId) return;
    const verdict = payloadField(e, "verdict");
    const run = await mustRun(hold.process_run_id);
    if (verdict === "approved") {
      if (hold.kind === "cascade_plan") {
        const plan = cascadePlanSchema.parse(fromJsonb(hold.payload));
        await executeInvalidation(plan);
      } else {
        await applyGraphChange(run, fromJsonb(hold.payload) as GraphDelta);
      }
      await db.sql`delete from processes.pending_actions where id = ${hold.id}`;
    } else {
      await db.withTx(async (tx) => {
        await txSql(tx)`delete from processes.pending_actions where id = ${hold.id}`;
        if (hold.kind === "cascade_plan") {
          const plan = cascadePlanSchema.parse(fromJsonb(hold.payload));
          await spine.append(tx, {
            tenantId: run.tenantId,
            topic: "process.cascade.discarded",
            subjectRefs: [{ kind: "process_run", id: run.id }],
            actor: { kind: "tenant", id: run.tenantId },
            payload: { dirtyNodeKey: plan.dirtyNodeKey, humanRequestId: hrRef.id },
          });
        }
      });
    }
  }

  /** An approved node_result gate completes its awaiting_approval node. */
  async function settleApprovedNodeGate(e: Event): Promise<void> {
    if (payloadField(e, "verdict") !== "approved") return;
    const itemRef = subjectOfKind(e, "work_item");
    if (itemRef === undefined) return;
    const item = await work.get(itemRef.id);
    if (
      item === undefined ||
      item.tenantId !== e.tenantId ||
      item.kind !== "process_node" ||
      item.status !== "awaiting_approval"
    ) {
      return;
    }
    await work.resolveApproval(item.id, e.actor);
  }

  async function onEvent(e: Event): Promise<InvalidationCause[]> {
    const causes: InvalidationCause[] = [];
    if (e.topic === "humangate.resolved") {
      const verdict = payloadField(e, "verdict");
      if (verdict !== "denied" && verdict !== "modified") return causes;
      const itemRef = subjectOfKind(e, "work_item");
      if (itemRef === undefined) return causes;
      const item = await work.get(itemRef.id);
      if (
        item === undefined ||
        item.tenantId !== e.tenantId ||
        item.kind !== "process_node" ||
        item.processRunId === undefined ||
        item.nodeKey === undefined
      ) {
        return causes;
      }
      const run = await getRun(item.processRunId);
      if (run === undefined || run.status !== "active") return causes;
      causes.push({
        kind: verdict === "denied" ? "denial" : "modification",
        processRunId: item.processRunId,
        nodeKey: item.nodeKey,
        eventId: e.id,
        ...(subjectOfKind(e, "human_request") !== undefined
          ? { humanRequestId: subjectOfKind(e, "human_request")!.id }
          : {}),
      });
      return causes;
    }

    if (e.topic === "context.doc.created" || e.topic === "context.doc.distilled") {
      const rows: WatchRuleRow[] = await db.sql`
        select * from processes.watch_rules where tenant_id = ${e.tenantId} order by id`;
      const seen = new Set<string>();
      for (const row of rows) {
        const rule = rowToWatchRule(row);
        if (!rule.match.topics.includes(e.topic)) continue;
        if (rule.mode === "interpret") {
          // One auditable LLM assertion run — P7 territory; LOUD until then.
          stubInterpretAssertion(rule, e);
        }
        if (!matchesWatchRule(rule.match, e)) continue;
        const dedupe = `${rule.processRunId}\n${rule.nodeKey}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const run = await getRun(rule.processRunId);
        if (run === undefined || run.status !== "active") continue;
        causes.push({
          kind: "watch_deterministic",
          processRunId: rule.processRunId,
          nodeKey: rule.nodeKey,
          eventId: e.id,
        });
      }
    }
    return causes;
  }

  async function planInvalidation(c: InvalidationCause): Promise<CascadePlan> {
    const run = await mustRun(c.processRunId);
    const { byKey, edges } = await keyGraph(run);
    if (!byKey.has(c.nodeKey)) throw new ProcessNodeNotFoundError(c.processRunId, c.nodeKey);
    const affected = walkDependents(c.nodeKey, edges);
    return cascadePlanSchema.parse({
      processRunId: c.processRunId,
      dirtyNodeKey: c.nodeKey,
      affected,
      width: 1 + affected.length,
      ...(c.eventId !== undefined ? { causeEventId: c.eventId } : {}),
    });
  }

  async function executeInvalidation(p: CascadePlan): Promise<void> {
    const run = await mustRun(p.processRunId);
    if (run.status !== "active") return;
    const { byKey } = await keyGraph(run);
    const actor: Ref = { kind: "tenant", id: run.tenantId };
    let staleCount = 0;

    // One node's cascade move. Dependents park (stale/pending) until their
    // upstreams are done again; only the dirty node is revived to rerun.
    async function invalidateNode(key: string, isDirty: boolean): Promise<void> {
      const item = byKey.get(key);
      if (item === undefined) return;
      switch (item.status) {
        case "claimed":
        case "running":
          await work.revokeLease(item.id, actor);
          if (!isDirty) await work.demote(item.id, actor);
          break;
        case "done":
        case "awaiting_approval":
          await gate.supersedeForSubject(
            run.tenantId,
            { kind: "work_item", id: item.id },
            p.causeEventId,
          );
          await results.supersede(run.tenantId, item.id, p.causeEventId);
          await work.markStale(item.id, actor);
          staleCount += 1;
          if (isDirty) await work.revive(item.id, actor);
          break;
        case "ready":
          if (!isDirty) await work.demote(item.id, actor);
          break;
        default:
          break; // pending / stale / blocked / failed / cancelled — nothing to move
      }
    }

    // Dependents first so nothing downstream is claimable while the dirty
    // node is being reset; the dirty node last, revived for its rerun.
    for (const key of p.affected) {
      await invalidateNode(key, false);
    }
    await invalidateNode(p.dirtyNodeKey, true);

    await db.withTx(async (tx) => {
      await spine.append(tx, {
        tenantId: run.tenantId,
        topic: "process.cascade.executed",
        subjectRefs: [{ kind: "process_run", id: run.id }],
        actor,
        ...(p.causeEventId !== undefined ? { causationId: p.causeEventId } : {}),
        payload: { dirtyNodeKey: p.dirtyNodeKey, staleCount },
      });
    });
  }

  return {
    async saveTemplate(t: NewProcessTemplate): Promise<ProcessTemplate> {
      const at = nowIso();
      const template = processTemplateSchema.parse({
        ...t,
        id: newUlid(),
        createdAt: at,
        updatedAt: at,
      });
      await db.withTx(async (tx) => {
        await txSql(tx)`
          insert into processes.process_templates
            (id, tenant_id, slug, version, mode, nodes, edges, change_policy,
             approval_request_id, created_at, updated_at)
          values
            (${template.id}, ${template.tenantId}, ${template.slug}, ${template.version},
             ${template.mode},
             ${JSON.stringify(template.nodes)}::text::jsonb,
             ${JSON.stringify(template.edges)}::text::jsonb,
             ${JSON.stringify(template.changePolicy)}::text::jsonb,
             ${template.approvalRequestId ?? null}, ${at}, ${at})`;
        await spine.append(tx, {
          tenantId: template.tenantId,
          topic: "process.template.saved",
          subjectRefs: [{ kind: "template", id: template.id }],
          actor: { kind: "tenant", id: template.tenantId },
          payload: { slug: template.slug, version: template.version, mode: template.mode },
        });
      });
      return template;
    },

    getRun,

    async instantiate(
      t: TemplateRef | DynamicSpec,
      subject: Ref,
      opts: InstantiateOptions,
    ): Promise<ProcessRun> {
      const owner: PrincipalContext = opts.owner;
      const bindings = opts.bindings ?? {};
      let nodes: NodeDef[];
      let edges: KeyEdge[];
      let templateRef: { id: Ulid; version: string } | undefined;
      let templateSlug: string | undefined;
      if ("mode" in t && t.mode === "dynamic") {
        nodes = t.initialNodes ?? [];
        edges = [];
      } else {
        const ref = t as TemplateRef;
        const rows: TemplateRow[] = await db.sql`
          select * from processes.process_templates
          where id = ${ref.id} and tenant_id = ${owner.tenantId}`;
        if (rows[0] === undefined) throw new ProcessTemplateNotFoundError(ref.id);
        const template = rowToTemplate(rows[0]);
        if (template.version !== ref.version) {
          throw new ProcessTemplateNotFoundError(
            `${template.slug} version ${ref.version} (stored: ${template.version})`,
          );
        }
        nodes = template.nodes;
        edges = template.edges.map((e) => ({ from: e.from, to: e.to }));
        templateRef = { id: template.id, version: template.version };
        templateSlug = template.slug;
      }

      const at = nowIso();
      const run = processRunSchema.parse({
        id: newUlid(),
        tenantId: owner.tenantId,
        ...(templateRef !== undefined ? { templateRef } : {}),
        subjectRef: subject,
        status: "active",
        graphRevision: 0,
        createdAt: at,
        updatedAt: at,
      });
      await db.withTx(async (tx) => {
        await txSql(tx)`
          insert into processes.process_runs
            (id, tenant_id, template_ref, subject_ref, status, graph_revision,
             bindings, created_at, updated_at)
          values
            (${run.id}, ${run.tenantId},
             ${templateRef === undefined ? null : JSON.stringify(templateRef)}::text::jsonb,
             ${JSON.stringify(run.subjectRef)}::text::jsonb,
             ${run.status}, ${run.graphRevision},
             ${JSON.stringify(bindings)}::text::jsonb, ${at}, ${at})`;
        await insertWatchRules(tx, run.tenantId, run.id, bindWatchRules(nodes, bindings));
        await spine.append(tx, {
          tenantId: run.tenantId,
          topic: "process.run.instantiated",
          subjectRefs: [{ kind: "process_run", id: run.id }, subject],
          actor: { kind: "principal", id: owner.principalId },
          payload: {
            ...(templateSlug !== undefined ? { templateSlug } : {}),
            nodeCount: nodes.length,
          },
        });
      });
      await openNodeItems(run, nodes, edges, owner.principalId);
      return run;
    },

    onEvent,
    planInvalidation,
    executeInvalidation,

    async handleEvent(e: Event): Promise<void> {
      if (e.topic === "humangate.resolved") {
        await settlePendingAction(e);
        await settleApprovedNodeGate(e);
      }
      for (const cause of await onEvent(e)) {
        const plan = await planInvalidation(cause);
        const autoExecute = plan.width <= autoExecuteMaxWidth;
        await db.withTx(async (tx) => {
          await spine.append(tx, {
            tenantId: e.tenantId,
            topic: "process.cascade.planned",
            subjectRefs: [{ kind: "process_run", id: plan.processRunId }],
            actor: { kind: "tenant", id: e.tenantId },
            causationId: e.id,
            payload: { dirtyNodeKey: plan.dirtyNodeKey, width: plan.width, autoExecute },
          });
        });
        if (autoExecute) {
          await executeInvalidation(plan);
        } else {
          const run = await mustRun(plan.processRunId);
          await parkPendingAction(run, "cascade_plan", plan, {
            kind: "approval",
            summary:
              `Rerun cascade from '${plan.dirtyNodeKey}' touches ${plan.width} node(s) ` +
              `(${[plan.dirtyNodeKey, ...plan.affected].join(" → ")}) — approve to execute.`,
            subjectKind: "cascade_plan",
            evidenceIds: [],
            options: ["approve", "deny"],
            routing: {
              assignee: "operator",
              channelPrefs: ["portal"],
              escalationPath: [],
              followUpCount: 0,
            },
            requestedBy: { kind: "tenant", id: e.tenantId },
          });
        }
      }
    },

    async proposeGraphChange(
      runId: Ulid,
      delta: GraphDelta,
      by: PrincipalContext,
    ): Promise<HumanRequestId> {
      const run = await mustRun(runId);
      if (run.tenantId !== by.tenantId) throw new ProcessRunNotFoundError(runId);
      const template =
        run.templateRef === undefined
          ? undefined
          : await (async () => {
              const rows: TemplateRow[] = await db.sql`
                select * from processes.process_templates where id = ${run.templateRef!.id}`;
              return rows[0] === undefined ? undefined : rowToTemplate(rows[0]);
            })();
      const policy = template?.changePolicy;
      const mode = template?.mode ?? "dynamic";
      if (mode === "fixed") {
        throw new GraphChangeRejectedError("template mode is 'fixed' — the graph is the graph");
      }
      const addNodes = delta.addNodes ?? [];
      const skipNodes = delta.skipNodes ?? [];
      if (policy !== undefined) {
        if (addNodes.length > 0 && !policy.allowAddNodes) {
          throw new GraphChangeRejectedError("changePolicy forbids adding nodes");
        }
        if (skipNodes.length > 0 && !policy.allowSkip) {
          throw new GraphChangeRejectedError("changePolicy forbids skipping nodes");
        }
        const protectedHit = skipNodes.find((k) => policy.protectedNodes.includes(k));
        if (protectedHit !== undefined) {
          throw new GraphChangeRejectedError(`node '${protectedHit}' is protected`);
        }
      }
      const { byKey } = await keyGraph(run);
      for (const key of skipNodes) {
        if (!byKey.has(key)) throw new GraphChangeRejectedError(`skip: unknown node '${key}'`);
      }
      const requestId = await parkPendingAction(run, "graph_change", delta, {
        kind: "approval",
        summary:
          `Instance-graph change on run ${run.id}: ` +
          `+${addNodes.length} node(s), skip [${skipNodes.join(", ")}] — ${delta.why}`,
        subjectKind: "template_change",
        evidenceIds: [],
        options: ["approve", "deny"],
        routing: {
          assignee: "operator",
          channelPrefs: ["portal"],
          escalationPath: [],
          followUpCount: 0,
        },
        requestedBy: { kind: "principal", id: by.principalId },
      });
      await db.withTx(async (tx) => {
        await spine.append(tx, {
          tenantId: run.tenantId,
          topic: "process.graph.change_proposed",
          subjectRefs: [{ kind: "process_run", id: run.id }],
          actor: { kind: "principal", id: by.principalId },
          payload: {
            humanRequestId: requestId,
            addNodeCount: addNodes.length,
            skipNodeKeys: skipNodes,
          },
        });
      });
      return requestId;
    },
  };
}
