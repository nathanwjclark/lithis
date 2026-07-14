import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import { z } from "zod";
import {
  HUMAN_REQUEST_KINDS,
  HUMAN_REQUEST_SUBJECT_KINDS,
  IllegalTransitionError,
  humanRequestSchema,
  humanResolutionSchema,
  nowIso,
  ulidSchema,
} from "@lithis/core";
import { HumanRequestNotFoundError } from "../../humangate";
import type { HumanGate, InboxFilter } from "../../humangate";
import type { ApiDeps } from "../deps";
import { principalFromHeaders } from "../identity";

/**
 * Routes for the humangate module (real as of P2-gate). The caller's identity
 * (dev headers) supplies tenantId/requestedBy/resolution.by — bodies carry
 * only what the caller may choose. Malformed bodies are a 400, unknown ids a
 * 404, illegal state-machine moves a 409; a boot without DATABASE_URL answers
 * 503 (config condition, not a stub).
 */

/** Body of POST /api/humangate/request — identity-derived fields are server-set. */
const requestBodySchema = humanRequestSchema.omit({
  id: true,
  tenantId: true,
  createdAt: true,
  updatedAt: true,
  state: true,
  resolution: true,
  requestedBy: true,
});

/** Body of POST /api/humangate/:id/resolve — by/at are server-set. */
const resolveBodySchema = humanResolutionSchema.omit({ by: true, at: true });

const csv = (raw: string): string[] => raw.split(",").filter((s) => s.length > 0);
const inboxQuerySchema = z.object({
  kinds: z
    .string()
    .transform(csv)
    .pipe(z.array(z.enum(HUMAN_REQUEST_KINDS)))
    .optional(),
  subjectKinds: z
    .string()
    .transform(csv)
    .pipe(z.array(z.enum(HUMAN_REQUEST_SUBJECT_KINDS)))
    .optional(),
  includeResolved: z.enum(["true", "false"]).optional(),
});

function gate(deps: ApiDeps): HumanGate {
  if (deps.humanGate === undefined) {
    throw new HTTPException(503, {
      message: "humangate is unavailable — server booted without DATABASE_URL",
    });
  }
  return deps.humanGate;
}

function parsed<T>(result: z.SafeParseReturnType<unknown, T>): T {
  if (!result.success) {
    throw new HTTPException(400, { message: result.error.issues[0]?.message ?? "invalid input" });
  }
  return result.data;
}

async function jsonBody(req: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HTTPException(400, { message: "request body must be JSON" });
  }
}

export function mountHumangateRoutes(app: Hono, deps: ApiDeps): void {
  // Handler order everywhere: identity (400) → availability (503) → input (400).
  app.get("/api/humangate/inbox", async (c) => {
    const p = principalFromHeaders(c);
    const humanGate = gate(deps);
    const q = parsed(inboxQuerySchema.safeParse(c.req.query()));
    const filter: InboxFilter = {
      ...(q.kinds !== undefined ? { kinds: q.kinds } : {}),
      ...(q.subjectKinds !== undefined ? { subjectKinds: q.subjectKinds } : {}),
      ...(q.includeResolved !== undefined ? { includeResolved: q.includeResolved === "true" } : {}),
    };
    return c.json(await humanGate.inbox(p, filter));
  });

  app.post("/api/humangate/request", async (c) => {
    const p = principalFromHeaders(c);
    const humanGate = gate(deps);
    const body = parsed(requestBodySchema.safeParse(await jsonBody(c.req)));
    const created = await humanGate.request({
      ...body,
      tenantId: p.tenantId,
      requestedBy: { kind: "principal", id: p.principalId },
    });
    return c.json(created, 201);
  });

  app.post("/api/humangate/:id/resolve", async (c) => {
    const p = principalFromHeaders(c);
    const humanGate = gate(deps);
    const id = parsed(ulidSchema.safeParse(c.req.param("id")));
    const body = parsed(resolveBodySchema.safeParse(await jsonBody(c.req)));
    const resolution = {
      ...body,
      by: { kind: "principal" as const, id: p.principalId },
      at: nowIso(),
    };
    try {
      return c.json(await humanGate.resolve(id, resolution, p));
    } catch (err) {
      if (err instanceof HumanRequestNotFoundError) {
        throw new HTTPException(404, { message: err.message });
      }
      if (err instanceof IllegalTransitionError) {
        throw new HTTPException(409, { message: err.message });
      }
      throw err;
    }
  });
}
