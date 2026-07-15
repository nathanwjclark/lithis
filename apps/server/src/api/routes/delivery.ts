import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import { z } from "zod";
import type { Delivery } from "../../delivery";
import type { ApiDeps } from "../deps";
import { principalFromHeaders } from "../identity";

/**
 * Routes for the delivery module (real as of P6-deliver): the transport-
 * agnostic inbound Slack ingress. Socket Mode is the production transport for
 * Slack events; this route accepts the SAME Events-API payload shape for
 * local development, tests, and (later) a signed request-URL deployment —
 * both funnel into Delivery.ingestSlackEvent. Identity comes from the dev
 * headers like every other route; Slack request signing lands with real auth.
 */

const urlVerificationSchema = z
  .object({ type: z.literal("url_verification"), challenge: z.string() })
  .passthrough();

function delivery(deps: ApiDeps): Delivery {
  if (deps.delivery === undefined) {
    throw new HTTPException(503, {
      message: "delivery is unavailable — server booted without DATABASE_URL",
    });
  }
  return deps.delivery;
}

async function jsonBody(req: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HTTPException(400, { message: "request body must be JSON" });
  }
}

export function mountDeliveryRoutes(app: Hono, deps: ApiDeps): void {
  // Handler order everywhere: identity (400) → availability (503) → input (400).
  app.post("/api/delivery/slack/events", async (c) => {
    const p = principalFromHeaders(c);
    const service = delivery(deps);
    const body = await jsonBody(c.req);

    // Slack's Events-API handshake — answered before any connection lookup.
    const verification = urlVerificationSchema.safeParse(body);
    if (verification.success) {
      return c.json({ challenge: verification.data.challenge });
    }

    if (deps.slackConnectionFor === undefined) {
      throw new HTTPException(503, {
        message: "delivery is unavailable — server booted without DATABASE_URL",
      });
    }
    const connection = await deps.slackConnectionFor(p.tenantId);
    if (connection === undefined) {
      throw new HTTPException(409, {
        message: "no slack connection registered for this tenant — register one first",
      });
    }
    const outcome = await service.ingestSlackEvent(connection, body);
    return c.json(outcome, outcome.ingested ? 202 : 200);
  });
}
