import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import { z } from "zod";
import { capabilitySchema, refSchema, ulidSchema } from "@lithis/core";
import type { ActionIntentService } from "../../iam";
import type { ApiDeps } from "../deps";
import { principalFromHeaders } from "../identity";

/**
 * Routes for the iam module's ActionIntent batches (real as of P12-browser):
 * propose a gated batch, read its items, and execute the approved ones.
 *
 * There is deliberately NO route that executes a single intent or bypasses the
 * gate — the only path to the outside world runs through a resolved
 * HumanRequest{action_batch}. Tenancy always comes from the caller identity,
 * never the body.
 */

const proposeBodySchema = z.object({
  principalId: ulidSchema.optional(),
  summary: z.string().min(1),
  assignee: z.union([refSchema, z.string().min(1)]).optional(),
  channelPrefs: z.array(z.enum(["portal", "slack", "teams", "email"])).optional(),
  slaHours: z.number().positive().optional(),
  evidenceIds: z.array(ulidSchema).optional(),
  items: z
    .array(
      z.object({
        capability: capabilitySchema,
        summary: z.string().min(1),
        params: z.unknown().optional(),
        counterpartRef: refSchema.optional(),
      }),
    )
    .min(1),
});

function actionsOf(deps: ApiDeps): ActionIntentService {
  if (deps.actions === undefined) {
    throw new HTTPException(503, {
      message: "action intents unavailable — server started without DATABASE_URL",
    });
  }
  return deps.actions;
}

async function jsonBody(c: { req: { text(): Promise<string> } }): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HTTPException(400, { message: "request body must be JSON" });
  }
}

export function mountIamRoutes(app: Hono, deps: ApiDeps): void {
  // Handler order everywhere: identity (400) → availability (503) → input (400).
  app.post("/api/iam/action-batches", async (c) => {
    const p = principalFromHeaders(c);
    const actions = actionsOf(deps);
    const parsed = proposeBodySchema.safeParse(await jsonBody(c));
    if (!parsed.success) {
      throw new HTTPException(400, { message: parsed.error.message });
    }
    const { principalId, items, assignee, channelPrefs, slaHours, evidenceIds, summary } =
      parsed.data;
    const result = await actions.proposeBatch({
      summary,
      ...(assignee !== undefined ? { assignee } : {}),
      ...(channelPrefs !== undefined ? { channelPrefs } : {}),
      ...(slaHours !== undefined ? { slaHours } : {}),
      ...(evidenceIds !== undefined ? { evidenceIds } : {}),
      items: items.map((item) => ({
        capability: item.capability,
        summary: item.summary,
        ...(item.params !== undefined ? { params: item.params } : {}),
        ...(item.counterpartRef !== undefined ? { counterpartRef: item.counterpartRef } : {}),
      })),
      tenantId: p.tenantId,
      // Batches act as the caller unless another principal is named explicitly.
      principalId: principalId ?? p.principalId,
      requestedBy: { kind: "principal", id: p.principalId },
    });
    return c.json(result, 201);
  });

  app.get("/api/iam/action-batches/:batchId", async (c) => {
    const p = principalFromHeaders(c);
    const actions = actionsOf(deps);
    const batchId = ulidSchema.safeParse(c.req.param("batchId"));
    if (!batchId.success) {
      throw new HTTPException(400, { message: "batch id must be a ULID" });
    }
    const items = await actions.listBatch(p.tenantId, batchId.data);
    if (items.length === 0) {
      throw new HTTPException(404, { message: `action batch ${batchId.data} not found` });
    }
    return c.json({ batchId: batchId.data, items });
  });

  app.post("/api/iam/action-batches/:batchId/execute", async (c) => {
    const p = principalFromHeaders(c);
    const actions = actionsOf(deps);
    const batchId = ulidSchema.safeParse(c.req.param("batchId"));
    if (!batchId.success) {
      throw new HTTPException(400, { message: "batch id must be a ULID" });
    }
    // Only approved/modified items run; proposed and denied ones are skipped,
    // so this route can never sidestep the gate.
    return c.json(await actions.executeBatch(p.tenantId, batchId.data));
  });
}
