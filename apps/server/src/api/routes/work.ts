import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import { WORK_ITEM_KINDS, ulidSchema, workItemSchema } from "@lithis/core";
import { z } from "zod";
import type { WorkQueue } from "../../work";
import type { ApiDeps } from "../deps";
import { principalFromHeaders } from "../identity";

/**
 * Routes for the work module (real as of P5-work). Identity comes from the
 * dev headers; tenancy always comes from the caller, never the body. Without
 * a database the queue is not constructed and these answer 503.
 */

/** Everything the caller supplies to open an item; tenant/owner come from identity. */
const openBodySchema = workItemSchema
  .omit({
    id: true,
    tenantId: true,
    ownerPrincipalId: true,
    status: true,
    attempt: true,
    lease: true,
    revision: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    /** Defaults to the calling principal. */
    ownerPrincipalId: ulidSchema.optional(),
  });

const claimBodySchema = z.object({
  kinds: z.array(z.enum(WORK_ITEM_KINDS)).optional(),
  processRunId: ulidSchema.optional(),
  ownedOnly: z.boolean().optional(),
});

function queueOf(deps: ApiDeps): WorkQueue {
  if (deps.workQueue === undefined) {
    throw new HTTPException(503, {
      message: "work queue unavailable — server started without DATABASE_URL",
    });
  }
  return deps.workQueue;
}

/** Parse the request body as JSON; an empty body reads as {}. */
async function jsonBody(c: { req: { text(): Promise<string> } }): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HTTPException(400, { message: "request body must be JSON" });
  }
}

export function mountWorkRoutes(app: Hono, deps: ApiDeps): void {
  app.post("/api/work/items", async (c) => {
    const p = principalFromHeaders(c);
    const parsed = openBodySchema.safeParse(await jsonBody(c));
    if (!parsed.success) {
      throw new HTTPException(400, { message: parsed.error.message });
    }
    const { ownerPrincipalId, ...item } = parsed.data;
    const id = await queueOf(deps).open({
      ...item,
      tenantId: p.tenantId,
      ownerPrincipalId: ownerPrincipalId ?? p.principalId,
    });
    return c.json({ id }, 201);
  });

  app.post("/api/work/claim", async (c) => {
    const p = principalFromHeaders(c);
    const parsed = claimBodySchema.safeParse(await jsonBody(c));
    if (!parsed.success) {
      throw new HTTPException(400, { message: parsed.error.message });
    }
    const f = parsed.data;
    return c.json(
      await queueOf(deps).claim(p, {
        ...(f.kinds !== undefined ? { kinds: f.kinds } : {}),
        ...(f.processRunId !== undefined ? { processRunId: f.processRunId } : {}),
        ...(f.ownedOnly !== undefined ? { ownedOnly: f.ownedOnly } : {}),
      }),
    );
  });
}
