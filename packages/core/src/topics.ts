import { z } from "zod";
import { costSchema } from "./common";
import { ulidSchema } from "./ids";
import { defineEventType } from "./events";
import { trustLevelSchema } from "./origin";

/**
 * The initial spine topic catalog. Domains register their topics HERE so the
 * registry is complete at module load; emitting an unregistered topic is a
 * bug. Payloads stay lean — the subjectRefs on the envelope carry identity;
 * payloads carry only what subscribers need without a fetch.
 */

// ── sessions ────────────────────────────────────────────────────────────────
export const T_SESSION_STARTED = defineEventType({
  topic: "session.started",
  description: "An agent/human session opened (loop wake, chat, run, workbench).",
  payload: z.object({ kind: z.enum(["loop", "chat", "run", "workbench"]) }),
});
export const T_SESSION_ENDED = defineEventType({
  topic: "session.ended",
  description: "Session closed; cost is final.",
  payload: z.object({ cost: costSchema, summary: z.string().optional() }),
});

// ── context ─────────────────────────────────────────────────────────────────
export const T_BLOB_CREATED = defineEventType({
  topic: "context.blob.created",
  description: "Raw bytes landed in object storage.",
  payload: z.object({ mediaType: z.string(), sizeBytes: z.number().int(), trust: trustLevelSchema }),
});
export const T_DOC_CREATED = defineEventType({
  topic: "context.doc.created",
  description: "A doc record exists (quarantined by default). Path/type WatchRules may fire here.",
  payload: z.object({ docType: z.string(), connectorSlug: z.string().optional() }),
});
export const T_DOC_DISTILLED = defineEventType({
  topic: "context.doc.distilled",
  description: "Ingest-time distill wrote summary + entities + links. Entity-scoped WatchRules fire here.",
  payload: z.object({ entityIds: z.array(ulidSchema), linkIds: z.array(ulidSchema) }),
});
export const T_ENTITY_CREATED = defineEventType({
  topic: "context.entity.created",
  description: "A structured entity (person/company/project/...) was created.",
  payload: z.object({ entityType: z.string(), degree: z.number().optional() }),
});
export const T_LINK_CREATED = defineEventType({
  topic: "context.link.created",
  description: "A typed association was asserted (at ingest or by an agent in a session).",
  payload: z.object({ verb: z.string() }),
});

// ── work ────────────────────────────────────────────────────────────────────
export const T_WORK_OPENED = defineEventType({
  topic: "work.item.opened",
  description: "A work item entered the graph.",
  payload: z.object({ kind: z.string(), processRunId: ulidSchema.optional() }),
});
export const T_WORK_STATUS = defineEventType({
  topic: "work.item.status_changed",
  description: "Work item state-machine transition.",
  payload: z.object({ from: z.string(), to: z.string(), attempt: z.number().int() }),
});
export const T_WORK_NOTE = defineEventType({
  topic: "work.note.added",
  description: "Append-only journal entry on a work item.",
  payload: z.object({ noteKind: z.enum(["status", "human", "system"]) }),
});

// ── processes ───────────────────────────────────────────────────────────────
export const T_PROCESS_INSTANTIATED = defineEventType({
  topic: "process.run.instantiated",
  description: "A process template was instantiated (nodes minted as work items, WatchRules bound).",
  payload: z.object({ templateSlug: z.string().optional(), nodeCount: z.number().int() }),
});
export const T_CASCADE_PLANNED = defineEventType({
  topic: "process.cascade.planned",
  description: "The Invalidator planned a rerun cascade (may itself gate on width).",
  payload: z.object({ dirtyNodeKey: z.string(), width: z.number().int(), autoExecute: z.boolean() }),
});
export const T_CASCADE_EXECUTED = defineEventType({
  topic: "process.cascade.executed",
  description: "Cascade applied: results superseded, dependents staled, leases revoked.",
  payload: z.object({ dirtyNodeKey: z.string(), staleCount: z.number().int() }),
});

// ── humangate ───────────────────────────────────────────────────────────────
export const T_HUMANGATE_REQUESTED = defineEventType({
  topic: "humangate.requested",
  description: "A human request was minted (approval/question/notification).",
  payload: z.object({ kind: z.string(), subjectKind: z.string() }),
});
export const T_HUMANGATE_RESOLVED = defineEventType({
  topic: "humangate.resolved",
  description: "A human resolved a request; resolution comment always present.",
  payload: z.object({ verdict: z.string() }),
});
export const T_HUMANGATE_SUPERSEDED = defineEventType({
  topic: "humangate.superseded",
  description: "A cascade invalidated a granted/pending request; original approvers notified.",
  payload: z.object({ causeEventId: ulidSchema.optional() }),
});

// ── runs ────────────────────────────────────────────────────────────────────
export const T_RUN_STARTED = defineEventType({
  topic: "run.started",
  description: "Agent run began inside a session.",
  payload: z.object({ model: z.string(), triggerCause: z.string() }),
});
export const T_RUN_FINISHED = defineEventType({
  topic: "run.finished",
  description: "Agent run ended (any terminal status); cost recorded.",
  payload: z.object({ status: z.string(), cost: costSchema }),
});

// ── conversations (welfare watchers ride this) ──────────────────────────────
export const T_CONVERSATION_MESSAGE = defineEventType({
  topic: "conversation.message",
  description:
    "Any inbound/outbound human↔agent message (slack, portal chat, email reply), ingested as a quarantined doc.",
  payload: z.object({
    direction: z.enum(["inbound", "outbound"]),
    channel: z.enum(["slack", "teams", "email", "portal"]),
    docId: ulidSchema,
  }),
});

// ── connectivity ────────────────────────────────────────────────────────────
export const T_SYNC_COMPLETED = defineEventType({
  topic: "connector.sync.completed",
  description: "A connector feed sync finished.",
  payload: z.object({ feed: z.string(), newDocs: z.number().int(), cursor: z.string().optional() }),
});
export const T_CONNECTION_HEALTH = defineEventType({
  topic: "connection.health.changed",
  description: "Connection health transitioned (healthy/degraded/expired/disabled).",
  payload: z.object({ from: z.string(), to: z.string(), error: z.string().optional() }),
});
export const T_FEED_MISSED = defineEventType({
  topic: "feed.expectation.missed",
  description: "An expected feed did not arrive within its grace window.",
  payload: z.object({ key: z.string(), missedCount: z.number().int() }),
});

// ── skills / artifacts / sor ────────────────────────────────────────────────
export const T_SKILL_PROPOSED = defineEventType({
  topic: "skill.version.proposed",
  description: "A skill version was proposed (self-modification enters the guardrail pipeline).",
  payload: z.object({ semver: z.string(), capabilityAdded: z.array(z.string()) }),
});
export const T_SKILL_ACTIVATED = defineEventType({
  topic: "skill.version.activated",
  description: "A skill version activated after PR merge + approval; checksum-bound.",
  payload: z.object({ semver: z.string(), checksum: z.string() }),
});
export const T_ARTIFACT_RENDERED = defineEventType({
  topic: "artifact.rendered",
  description: "A template rendered an artifact draft.",
  payload: z.object({ templateSlug: z.string() }),
});
export const T_ARTIFACT_VERIFIED = defineEventType({
  topic: "artifact.verified",
  description: "Artifact verification ran; result is an evidence record.",
  payload: z.object({ passed: z.boolean() }),
});
export const T_SOR_MIGRATION_PROPOSED = defineEventType({
  topic: "sor.migration.proposed",
  description: "A system-of-record schema migration was proposed (approval-gated).",
  payload: z.object({ sorSlug: z.string(), version: z.number().int() }),
});
export const T_SOR_MIGRATION_APPLIED = defineEventType({
  topic: "sor.migration.applied",
  description: "An approved SoR migration was applied.",
  payload: z.object({ sorSlug: z.string(), version: z.number().int(), appliedBy: z.string() }),
});

// ── delivery / workspace ────────────────────────────────────────────────────
export const T_DELIVERY_SENT = defineEventType({
  topic: "delivery.sent",
  description: "A card/digest/nudge was delivered via a connector's act().",
  payload: z.object({ channel: z.string(), kind: z.string() }),
});
export const T_WORKSPACE_STATUS = defineEventType({
  topic: "workspace.status_changed",
  description: "Workbench workspace lifecycle transition (sentinel-visible).",
  payload: z.object({ from: z.string(), to: z.string() }),
});

// ── agents (resident loop) ──────────────────────────────────────────────────
export const T_AGENT_WOKE = defineEventType({
  topic: "agent.woke",
  description: "A resident agent woke (heartbeat/message/event/work_available/manual).",
  payload: z.object({ reason: z.enum(["heartbeat", "message", "event", "work_available", "manual"]) }),
});
export const T_AGENT_SLEPT = defineEventType({
  topic: "agent.slept",
  description: "A resident agent closed its session and scheduled its own next wake.",
  payload: z.object({ nextWakeAt: z.string().optional() }),
});
