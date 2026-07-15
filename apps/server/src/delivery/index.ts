import type {
  Connection,
  Event,
  HumanRequest,
  IsoDateTime,
  Ulid,
} from "@lithis/core";
import type { ConnectorAuthProvider as SdkConnectorAuthProvider } from "@lithis/sdk/connectors";
import { stub } from "@lithis/stubkit";
import type { Db } from "../db";
import type { ConnectionRegistry, ConnectorRuntime } from "../connections";
import type { ContextStore } from "../context";
import type { HumanGate } from "../humangate";
import type { EventSpine, Subscription } from "../spine";
import { createPgDelivery } from "./service";

/**
 * delivery — renders and routes evidence-first cards, digests, and nudges to
 * Slack/Teams/email/portal VIA connectors' act(). Delivery owns presentation,
 * never transport credentials; every send emits delivery.sent (failures emit
 * delivery.failed — nothing is dropped silently).
 *
 * REAL as of P6-deliver for the Slack channel: humangate.requested/follow_up
 * events become Block Kit evidence cards / threaded nudges posted through the
 * slack connector's chat.write under custody-brokered auth, with the returned
 * "channel:ts" persisted as the thread anchor; inbound Slack message events
 * (Socket Mode client in ./socketmode.ts, or the HTTP ingress route) are
 * ingested as quarantined message docs + conversation.message events, and
 * thread replies on delivered cards resolve their HumanRequest
 * (approve/deny → approval, "answer: ..."/option → question, ack →
 * notification). Teams/email rendering remains stubbed.
 */

export type DeliveryChannel = "slack" | "teams" | "email" | "portal";

export interface DeliveryTarget {
  channel: DeliveryChannel;
  /** Channel-specific address: a slack channel id, an email, a portal principal. */
  target: string;
}

/** What gets rendered: a human request card, a digest, or a nudge. */
export type Renderable =
  | { kind: "human_request"; request: HumanRequest }
  | { kind: "digest"; tenantId: Ulid; title: string; humanRequestIds: Ulid[] }
  | {
      kind: "nudge";
      request: HumanRequest;
      followUpCount: number;
      /** The original card's anchor ("channel:ts") — nudges post into its thread. */
      threadExternalId?: string;
    };

export interface RenderedCard {
  tenantId: Ulid;
  channel: DeliveryChannel;
  kind: "human_request" | "digest" | "nudge";
  /** Channel-native payload (Block Kit JSON, MJML, portal card JSON). */
  body: unknown;
  evidenceIds: Ulid[];
  humanRequestId?: Ulid;
  /** Thread anchor to post into, when the card is a threaded follow-up. */
  threadExternalId?: string;
}

/** One row of the delivery ledger — every send attempt, honest either way. */
export interface DeliveryRecord {
  id: Ulid;
  tenantId: Ulid;
  kind: RenderedCard["kind"];
  channel: DeliveryChannel;
  target: string;
  humanRequestId?: Ulid;
  connectionId?: Ulid;
  status: "sent" | "failed";
  /** Channel-native anchor of the sent thing — "channel:ts" for Slack. */
  externalId?: string;
  detail?: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface InboundOutcome {
  ingested: boolean;
  docId?: Ulid;
  reason?: string;
}

export interface Delivery {
  render(r: Renderable, channel: DeliveryChannel): Promise<RenderedCard>;
  /** Sends via the target channel's connector act(); persists the delivery record and emits delivery.sent/failed. */
  route(card: RenderedCard, target: DeliveryTarget): Promise<DeliveryRecord>;
  /**
   * Transport-agnostic inbound ingress: a Slack message event (from Socket
   * Mode or the HTTP route) → quarantined message doc + conversation.message
   * on the spine. Reply→resolve mapping rides the conversation.message
   * subscription, not this call.
   */
  ingestSlackEvent(connection: Connection, payload: unknown): Promise<InboundOutcome>;
  /** The delivered card a thread anchor points at (sent rows only). */
  findByAnchor(tenantId: Ulid, externalId: string): Promise<DeliveryRecord | undefined>;
}

/** The runtime face: the spine-subscription handlers live here for wiring + tests. */
export interface DeliveryRuntime extends Delivery {
  /** humangate.requested → evidence card; humangate.follow_up → threaded nudge. */
  handleHumangateEvent(e: Event): Promise<void>;
  /** conversation.message (inbound slack thread reply) → humanGate.resolve. */
  handleConversationMessage(e: Event): Promise<void>;
}

export interface DeliveryDeps {
  db: Db;
  spine: EventSpine;
  humanGate: HumanGate;
  /** Resolves the slack connector registered by main.ts. */
  runtime: ConnectorRuntime;
  /** Custody-brokered auth for connector act() calls (never raw secrets). */
  auth: SdkConnectorAuthProvider;
  connections: Pick<ConnectionRegistry, "findByConnector">;
  /** Inbound messages land as quarantined docs here. */
  contextStore: ContextStore;
  /** Default Slack channel cards post to (SLACK_DELIVERY_CHANNEL). */
  slackChannel?: string;
  /** Injectable for tests; defaults to the teams/email/portal render stub. */
  renderUnsupportedChannel?: (r: Renderable, channel: DeliveryChannel) => RenderedCard;
}

/** Teams/email/portal card rendering is not built yet — slack is the P6 channel. */
const renderUnsupportedChannel = stub<(r: Renderable, channel: DeliveryChannel) => RenderedCard>(
  "server.delivery.render.non_slack",
  "LITHIS-STUB: teams/email/portal card rendering not implemented — slack is the P6-deliver channel; portal cards land with P9-portal",
);

export function createDelivery(deps: DeliveryDeps): DeliveryRuntime {
  return createPgDelivery({
    ...deps,
    renderUnsupportedChannel: deps.renderUnsupportedChannel ?? renderUnsupportedChannel,
  });
}

/**
 * DB-less skeleton mode (DATABASE_URL unset): delivery cannot run. Honest
 * CONFIG degrade, not a stub — the real implementation exists and is wired
 * whenever a database (and the connectivity stack) is configured.
 */
export function createUnconfiguredDelivery(): DeliveryRuntime {
  const fail = (): never => {
    throw new Error(
      "delivery unavailable: DATABASE_URL is not set — the server is running in DB-less skeleton mode",
    );
  };
  return {
    render: fail,
    route: fail,
    ingestSlackEvent: fail,
    findByAnchor: fail,
    handleHumangateEvent: fail,
    handleConversationMessage: fail,
  };
}

/**
 * Wire the delivery consumers onto the spine (called at boot wherever the
 * dispatcher runs; delivery is stateless between events, so at-least-once
 * redelivery is safe — resolves are transition-guarded).
 */
export function attachDeliverySubscriptions(
  spine: EventSpine,
  delivery: DeliveryRuntime,
): Subscription[] {
  return [
    spine.subscribe(
      "delivery.cards",
      { topics: ["humangate.requested", "humangate.follow_up"] },
      (e) => delivery.handleHumangateEvent(e),
    ),
    spine.subscribe(
      "delivery.replies",
      { topics: ["conversation.message"] },
      (e) => delivery.handleConversationMessage(e),
    ),
  ];
}

export { createSocketModeClient, SLACK_CONNECTIONS_OPEN_URL } from "./socketmode";
export type { SocketModeClient, SocketModeOptions } from "./socketmode";
export { parseReplyVerdict, shouldIngestInbound, unwrapSlackEvent } from "./inbound";
export {
  decodeAnchor,
  encodeAnchor,
  renderDigest,
  renderHumanRequestCard,
  renderNudge,
  replyInstructions,
} from "./render";
