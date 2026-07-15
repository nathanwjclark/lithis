import {
  IllegalTransitionError,
  newUlid,
  nowIso,
} from "@lithis/core";
import type { Connection, Event, HumanRequest, Origin, Ref, Ulid } from "@lithis/core";
import type { ActionReceipt } from "@lithis/sdk/connectors";
import { txSql } from "../db";
import type { DbTx } from "../db";
import { HumanRequestNotFoundError } from "../humangate";
import {
  parseReplyVerdict,
  shouldIngestInbound,
  unwrapSlackEvent,
} from "./inbound";
import type { SlackMessageEvent } from "./inbound";
import {
  decodeAnchor,
  encodeAnchor,
  renderDigest,
  renderHumanRequestCard,
  renderNudge,
} from "./render";
import type {
  Delivery,
  DeliveryDeps,
  DeliveryRecord,
  DeliveryRuntime,
  DeliveryTarget,
  InboundOutcome,
  Renderable,
  RenderedCard,
} from "./index";

/**
 * The Postgres-backed delivery service. Outbound: humangate.* events →
 * Block Kit evidence cards → the slack connector's chat.write act() under
 * custody-brokered auth; every send (or failure) lands as a delivery row AND
 * a delivery.sent / delivery.failed event in the same transaction. Inbound:
 * Slack message events (Socket Mode or the HTTP ingress) are ingested as
 * quarantined message docs + conversation.message events; the reply
 * subscriber maps thread replies on delivered cards to humanGate.resolve.
 */

const CONVERSATION_MESSAGE_TOPIC = "conversation.message";

interface DeliveryRow {
  id: string;
  tenant_id: string;
  kind: string;
  channel: string;
  target: string;
  human_request_id: string | null;
  connection_id: string | null;
  status: string;
  external_id: string | null;
  detail: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToRecord(row: DeliveryRow): DeliveryRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind as DeliveryRecord["kind"],
    channel: row.channel as DeliveryRecord["channel"],
    target: row.target,
    ...(row.human_request_id !== null ? { humanRequestId: row.human_request_id } : {}),
    ...(row.connection_id !== null ? { connectionId: row.connection_id } : {}),
    status: row.status as DeliveryRecord["status"],
    ...(row.external_id !== null ? { externalId: row.external_id } : {}),
    ...(row.detail !== null ? { detail: row.detail } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** Mirrors the slack connector's messageSlug — one slug per (channel, ts). */
function inboundMessageSlug(channelId: string, ts: string): string {
  return `slack-msg-${channelId.toLowerCase()}-${ts.replace(".", "-")}`;
}

type ResolvedDeliveryDeps = DeliveryDeps &
  Required<Pick<DeliveryDeps, "renderUnsupportedChannel">>;

export function createPgDelivery(deps: ResolvedDeliveryDeps): DeliveryRuntime {
  const { db, spine, humanGate, contextStore } = deps;

  // ── persistence ────────────────────────────────────────────────────────────

  async function insertRecord(
    tx: DbTx,
    record: DeliveryRecord,
  ): Promise<void> {
    await txSql(tx)`
      insert into delivery.deliveries
        (id, tenant_id, kind, channel, target, human_request_id, connection_id,
         status, external_id, detail, created_at, updated_at)
      values
        (${record.id}, ${record.tenantId}, ${record.kind}, ${record.channel},
         ${record.target}, ${record.humanRequestId ?? null}, ${record.connectionId ?? null},
         ${record.status}, ${record.externalId ?? null}, ${record.detail ?? null},
         ${record.createdAt}, ${record.updatedAt})`;
  }

  /** Persist the outcome + its event atomically (the transactional outbox). */
  async function recordOutcome(
    card: RenderedCard,
    target: DeliveryTarget,
    connectionId: Ulid | undefined,
    outcome: { ok: true; externalId: string; detail?: string } | { ok: false; reason: string },
  ): Promise<DeliveryRecord> {
    const at = nowIso();
    const record: DeliveryRecord = {
      id: newUlid(),
      tenantId: card.tenantId,
      kind: card.kind,
      channel: target.channel,
      target: target.target,
      ...(card.humanRequestId !== undefined ? { humanRequestId: card.humanRequestId } : {}),
      ...(connectionId !== undefined ? { connectionId } : {}),
      status: outcome.ok ? "sent" : "failed",
      ...(outcome.ok ? { externalId: outcome.externalId } : {}),
      ...(outcome.ok
        ? outcome.detail !== undefined
          ? { detail: outcome.detail }
          : {}
        : { detail: outcome.reason }),
      createdAt: at,
      updatedAt: at,
    };
    const subjectRefs: Ref[] = [
      ...(card.humanRequestId !== undefined
        ? [{ kind: "human_request", id: card.humanRequestId } as Ref]
        : []),
      ...(connectionId !== undefined ? [{ kind: "connection", id: connectionId } as Ref] : []),
    ];
    const actor: Ref =
      connectionId !== undefined
        ? { kind: "connection", id: connectionId }
        : { kind: "tenant", id: card.tenantId };
    await db.withTx(async (tx) => {
      await insertRecord(tx, record);
      await spine.append(tx, {
        tenantId: card.tenantId,
        topic: outcome.ok ? "delivery.sent" : "delivery.failed",
        subjectRefs,
        actor,
        ...(outcome.ok ? {} : { severity: "warning" as const }),
        payload: {
          channel: target.channel,
          kind: card.kind,
          target: target.target,
          ...(card.humanRequestId !== undefined ? { humanRequestId: card.humanRequestId } : {}),
          ...(connectionId !== undefined ? { connectionId } : {}),
          ...(outcome.ok ? { externalId: outcome.externalId } : { reason: outcome.reason }),
        },
      });
    });
    return record;
  }

  async function findByAnchor(
    tenantId: Ulid,
    externalId: string,
  ): Promise<DeliveryRecord | undefined> {
    const rows: DeliveryRow[] = await db.sql`
      select * from delivery.deliveries
      where tenant_id = ${tenantId} and external_id = ${externalId} and status = 'sent'
      order by created_at desc, id desc
      limit 1`;
    return rows[0] === undefined ? undefined : rowToRecord(rows[0]);
  }

  /** The sent card for a request — nudges and replies thread onto its anchor. */
  async function findSentCard(
    tenantId: Ulid,
    humanRequestId: Ulid,
  ): Promise<DeliveryRecord | undefined> {
    const rows: DeliveryRow[] = await db.sql`
      select * from delivery.deliveries
      where tenant_id = ${tenantId} and human_request_id = ${humanRequestId}
        and kind = 'human_request' and status = 'sent'
      order by created_at desc, id desc
      limit 1`;
    return rows[0] === undefined ? undefined : rowToRecord(rows[0]);
  }

  // ── outbound ───────────────────────────────────────────────────────────────

  async function render(r: Renderable, channel: RenderedCard["channel"]): Promise<RenderedCard> {
    if (channel !== "slack") return deps.renderUnsupportedChannel(r, channel);
    switch (r.kind) {
      case "human_request":
        return {
          tenantId: r.request.tenantId,
          channel,
          kind: "human_request",
          body: renderHumanRequestCard(r.request),
          evidenceIds: r.request.evidenceIds,
          humanRequestId: r.request.id,
        };
      case "digest":
        return {
          tenantId: r.tenantId,
          channel,
          kind: "digest",
          body: renderDigest(r.title, r.humanRequestIds),
          evidenceIds: [],
        };
      case "nudge":
        return {
          tenantId: r.request.tenantId,
          channel,
          kind: "nudge",
          body: renderNudge(r.request, r.followUpCount),
          evidenceIds: r.request.evidenceIds,
          humanRequestId: r.request.id,
          ...(r.threadExternalId !== undefined ? { threadExternalId: r.threadExternalId } : {}),
        };
    }
  }

  async function route(card: RenderedCard, target: DeliveryTarget): Promise<DeliveryRecord> {
    if (target.channel !== "slack" || card.channel !== "slack") {
      return recordOutcome(card, target, undefined, {
        ok: false,
        reason: `delivery routing for channel '${target.channel}' is not implemented — slack only (P6)`,
      });
    }
    const connections = await deps.connections.findByConnector("slack", card.tenantId);
    const connection = connections[0];
    if (connection === undefined) {
      return recordOutcome(card, target, undefined, {
        ok: false,
        reason: "no slack connection registered for this tenant",
      });
    }
    const connector = deps.runtime.resolve("slack");
    if (connector === undefined) {
      return recordOutcome(card, target, connection.id, {
        ok: false,
        reason: "no slack connector registered in the runtime",
      });
    }
    const body = card.body as { text: string; blocks: unknown[] };
    const thread = card.threadExternalId !== undefined ? decodeAnchor(card.threadExternalId) : undefined;
    const intentId = newUlid(); // becomes the ActionIntent id once the ToolBroker (P7) mints real intents
    let receipt: ActionReceipt;
    try {
      const brokered = await deps.auth.getAuth(connection);
      receipt = await connector.act(
        connection,
        {
          key: "chat.write",
          params: {
            channel: target.target,
            text: body.text,
            blocks: body.blocks,
            ...(thread !== undefined ? { thread_ts: thread.ts } : {}),
          },
          intentId,
        },
        brokered,
      );
    } catch (err) {
      return recordOutcome(card, target, connection.id, {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    if (!receipt.ok || receipt.externalId === undefined) {
      return recordOutcome(card, target, connection.id, {
        ok: false,
        reason: receipt.detail ?? "connector act() returned ok: false",
      });
    }
    return recordOutcome(card, target, connection.id, {
      ok: true,
      externalId: receipt.externalId,
      ...(receipt.detail !== undefined ? { detail: receipt.detail } : {}),
    });
  }

  /** humangate.requested → card; humangate.follow_up → threaded nudge. */
  async function handleHumangateEvent(e: Event): Promise<void> {
    const requestRef = e.subjectRefs.find((r) => r.kind === "human_request");
    if (requestRef === undefined) return;
    const request = await humanGate.get(requestRef.id, e.tenantId);
    if (request === undefined) return;
    if (!request.routing.channelPrefs.includes("slack")) return;
    if (request.state !== "pending") return; // resolved/expired since the event was written

    const channel = deps.slackChannel;
    const renderable = await (async (): Promise<Renderable> => {
      if (e.topic === "humangate.follow_up") {
        const original = await findSentCard(e.tenantId, request.id);
        if (original?.externalId !== undefined) {
          return {
            kind: "nudge",
            request,
            followUpCount: request.routing.followUpCount,
            threadExternalId: original.externalId,
          };
        }
      }
      return { kind: "human_request", request };
    })();

    const card = await render(renderable, "slack");
    if (channel === undefined) {
      await recordOutcome(card, { channel: "slack", target: "(unconfigured)" }, undefined, {
        ok: false,
        reason:
          "request prefers slack but SLACK_DELIVERY_CHANNEL is not configured — set it to the default card channel",
      });
      return;
    }
    await route(card, { channel: "slack", target: channel });
  }

  // ── inbound ────────────────────────────────────────────────────────────────

  async function ingestSlackEvent(
    connection: Connection,
    payload: unknown,
  ): Promise<InboundOutcome> {
    const event = unwrapSlackEvent(payload);
    if (event === undefined) {
      return { ingested: false, reason: "payload is not a Slack message event" };
    }
    if (!shouldIngestInbound(event)) {
      return { ingested: false, reason: "skipped: bot message, subtyped noise, or empty text" };
    }
    let docId: Ulid;
    try {
      docId = await ingestInboundDoc(connection, event);
    } catch (err) {
      // Socket Mode redelivers unacked envelopes; the doc slug is one-per-
      // (channel, ts), so a duplicate-key violation means this exact message
      // already landed (and already emitted its conversation.message).
      if (err instanceof Error && /already exists|duplicate key value/.test(err.message)) {
        return {
          ingested: false,
          reason: `already ingested: slack message ${event.channel}:${event.ts}`,
        };
      }
      throw err;
    }
    const externalId = encodeAnchor(event.channel, event.ts);
    const threadExternalId =
      event.thread_ts !== undefined && event.thread_ts !== event.ts
        ? encodeAnchor(event.channel, event.thread_ts)
        : undefined;
    await db.withTx(async (tx) => {
      await spine.append(tx, {
        tenantId: connection.tenantId,
        topic: CONVERSATION_MESSAGE_TOPIC,
        subjectRefs: [
          { kind: "doc", id: docId },
          { kind: "connection", id: connection.id },
        ],
        actor: { kind: "connection", id: connection.id },
        payload: {
          direction: "inbound",
          channel: "slack",
          docId,
          connectionId: connection.id,
          externalId,
          ...(threadExternalId !== undefined ? { threadExternalId } : {}),
          ...(event.user !== undefined ? { authorExternalId: event.user } : {}),
          ...(event.text !== undefined ? { text: event.text } : {}),
        },
      });
    });
    return { ingested: true, docId };
  }

  async function ingestInboundDoc(
    connection: Connection,
    event: SlackMessageEvent,
  ): Promise<Ulid> {
    const origin: Origin = {
      by: { kind: "connection", id: connection.id },
      method: "external",
      trust: "internal", // workspace members' own comms; still quarantined at ingest
      at: nowIso(),
    };
    const blobRef = await contextStore.putBlob(
      { tenantId: connection.tenantId, mediaType: "application/json", origin },
      new TextEncoder().encode(JSON.stringify(event)),
    );
    const author = event.user ?? "unknown";
    const snippet = (event.text ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    const docRef = await contextStore.ingestDoc({
      tenantId: connection.tenantId,
      type: "message",
      slug: inboundMessageSlug(event.channel, event.ts),
      title: `slack ${event.channel} — ${author}: ${snippet === "" ? `(message ${event.ts})` : snippet}`,
      bodyBlobId: blobRef.id,
      frontmatter: {
        source: "slack",
        channelId: event.channel,
        ts: event.ts,
        ...(event.thread_ts !== undefined ? { threadTs: event.thread_ts } : {}),
        ...(event.user !== undefined ? { userId: event.user } : {}),
        ...(event.team !== undefined ? { team: event.team } : {}),
      },
      origin,
    });
    return docRef.id;
  }

  /** conversation.message → (thread on a delivered card?) → humanGate.resolve. */
  async function handleConversationMessage(e: Event): Promise<void> {
    const payload = e.payload as {
      direction?: string;
      channel?: string;
      connectionId?: string;
      threadExternalId?: string;
      authorExternalId?: string;
      text?: string;
    };
    if (payload.direction !== "inbound" || payload.channel !== "slack") return;
    if (payload.threadExternalId === undefined || payload.text === undefined) return;

    const record = await findByAnchor(e.tenantId, payload.threadExternalId);
    if (record?.humanRequestId === undefined || record.kind !== "human_request") return;
    const request = await humanGate.get(record.humanRequestId, e.tenantId);
    if (request === undefined || request.state !== "pending") return;

    const parsed = parseReplyVerdict(request, payload.text);
    if (parsed === undefined) {
      console.log(
        `delivery: reply on card ${record.id} (request ${request.id}) did not parse as a ` +
          `${request.kind} verdict — ignoring: ${JSON.stringify(payload.text.slice(0, 120))}`,
      );
      return;
    }
    const connectionId = payload.connectionId ?? record.connectionId;
    const by: Ref =
      connectionId !== undefined
        ? { kind: "connection", id: connectionId }
        : { kind: "tenant", id: e.tenantId };
    const author = payload.authorExternalId ?? "unknown user";
    try {
      await humanGate.resolve(
        request.id,
        {
          by,
          at: nowIso(),
          verdict: parsed.verdict,
          comment: `${parsed.comment} (via slack reply from ${author})`,
        },
        { tenantId: e.tenantId, principalId: connectionId ?? e.tenantId, kind: "service" },
      );
    } catch (err) {
      // A racing resolve (portal, another reply) is a normal outcome, not a
      // redeliverable failure — the first verdict stands.
      if (err instanceof IllegalTransitionError || err instanceof HumanRequestNotFoundError) {
        console.log(`delivery: request ${request.id} was resolved elsewhere first — ignoring reply`);
        return;
      }
      throw err;
    }
  }

  return {
    render,
    route,
    ingestSlackEvent,
    findByAnchor,
    handleHumangateEvent,
    handleConversationMessage,
  };
}
