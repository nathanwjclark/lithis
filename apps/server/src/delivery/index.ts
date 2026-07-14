import type { HumanRequest, Ulid } from "@lithis/core";
import { stubService } from "@lithis/stubkit";

/**
 * delivery — renders and routes evidence-first cards, digests, and nudges to
 * Slack/Teams/email/portal VIA connectors' act(). Delivery owns presentation,
 * never transport credentials; every send emits delivery.sent.
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
  | { kind: "digest"; title: string; humanRequestIds: Ulid[] }
  | { kind: "nudge"; humanRequestId: Ulid; followUpCount: number };

export interface RenderedCard {
  channel: DeliveryChannel;
  /** Channel-native payload (Block Kit JSON, MJML, portal card JSON). */
  body: unknown;
  evidenceIds: Ulid[];
}

export interface Delivery {
  render(r: Renderable, channel: DeliveryChannel): Promise<RenderedCard>;
  /** Sends via the target channel's connector act(); emits delivery.sent. */
  route(card: RenderedCard, target: DeliveryTarget): Promise<void>;
}

const delivery = stubService<Delivery>(
  "server.delivery.delivery",
  ["render", "route"],
  "LITHIS-STUB: card/digest/nudge rendering and connector-routed sending not implemented",
);

export function createDelivery(): Delivery {
  return delivery;
}
