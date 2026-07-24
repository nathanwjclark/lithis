import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import { z } from "zod";
import { slugSchema, sorTableSchema, ulidSchema } from "@lithis/core";
import {
  SorColumnError,
  SorDescriptorNotFoundError,
  SorDestructiveMigrationError,
  SorIdentifierError,
  SorNotApprovedError,
  SorProposalPendingError,
  SorSchemaNotAppliedError,
} from "../../sor";
import type { SorRuntime } from "../../sor";
import type { ApiDeps } from "../deps";
import { principalFromHeaders } from "../identity";

/**
 * Routes for the sor module (real as of P11): propose a descriptor version
 * (opens the sor_migration gate carrying the exact DDL), apply an approved
 * migration, read systems, and touch rows through the SCOPED table handle.
 * There is deliberately no raw-SQL route — the handle is the only write path.
 */

const proposeBodySchema = z.object({
  slug: slugSchema,
  displayName: z.string().min(1),
  version: z.number().int().positive(),
  tables: z.array(sorTableSchema).min(1),
});

const insertBodySchema = z.object({
  row: z.record(z.unknown()),
  entityRef: z.object({ kind: z.string(), id: ulidSchema }).optional(),
});

const selectBodySchema = z.object({ where: z.record(z.unknown()).optional() });

function runtimeOf(deps: ApiDeps): SorRuntime {
  if (deps.sor === undefined) {
    throw new HTTPException(503, {
      message: "SoR runtime unavailable — server started without DATABASE_URL",
    });
  }
  return deps.sor;
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

function rethrow(err: unknown): never {
  if (err instanceof SorDescriptorNotFoundError) {
    throw new HTTPException(404, { message: err.message });
  }
  if (
    err instanceof SorDestructiveMigrationError ||
    err instanceof SorIdentifierError ||
    err instanceof SorColumnError
  ) {
    throw new HTTPException(400, { message: err.message });
  }
  if (
    err instanceof SorNotApprovedError ||
    err instanceof SorProposalPendingError ||
    err instanceof SorSchemaNotAppliedError
  ) {
    throw new HTTPException(409, { message: err.message });
  }
  throw err;
}

export function mountSorRoutes(app: Hono, deps: ApiDeps): void {
  app.post("/api/sor/propose", async (c) => {
    const p = principalFromHeaders(c);
    const runtime = runtimeOf(deps);
    const parsed = proposeBodySchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw new HTTPException(400, { message: parsed.error.message });
    try {
      const approvalRequestId = await runtime.propose({ ...parsed.data, tenantId: p.tenantId }, p);
      return c.json({ approvalRequestId }, 201);
    } catch (err) {
      rethrow(err);
    }
  });

  app.get("/api/sor", async (c) => {
    const p = principalFromHeaders(c);
    return c.json(await runtimeOf(deps).list(p.tenantId));
  });

  app.get("/api/sor/:id", async (c) => {
    const p = principalFromHeaders(c);
    const runtime = runtimeOf(deps);
    const id = ulidSchema.safeParse(c.req.param("id"));
    if (!id.success) throw new HTTPException(400, { message: "descriptor id must be a ULID" });
    const state = await runtime.get(id.data, p.tenantId);
    if (state === undefined) throw new HTTPException(404, { message: "SoR descriptor not found" });
    return c.json(state);
  });

  app.post("/api/sor/:id/apply", async (c) => {
    const p = principalFromHeaders(c);
    const runtime = runtimeOf(deps);
    const id = ulidSchema.safeParse(c.req.param("id"));
    if (!id.success) throw new HTTPException(400, { message: "descriptor id must be a ULID" });
    try {
      await runtime.apply(id.data, p);
    } catch (err) {
      rethrow(err);
    }
    return c.json({ applied: id.data });
  });

  app.post("/api/sor/:slug/tables/:table/rows", async (c) => {
    const p = principalFromHeaders(c);
    const runtime = runtimeOf(deps);
    const parsed = insertBodySchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw new HTTPException(400, { message: parsed.error.message });
    try {
      const handle = runtime.table<Record<string, unknown>>(
        c.req.param("slug"),
        c.req.param("table"),
        p,
      );
      const row = await handle.insert(
        parsed.data.row,
        parsed.data.entityRef === undefined
          ? undefined
          : { entityRef: parsed.data.entityRef as { kind: never; id: string } },
      );
      return c.json(row, 201);
    } catch (err) {
      rethrow(err);
    }
  });

  app.post("/api/sor/:slug/tables/:table/select", async (c) => {
    const p = principalFromHeaders(c);
    const runtime = runtimeOf(deps);
    const parsed = selectBodySchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw new HTTPException(400, { message: parsed.error.message });
    try {
      const handle = runtime.table<Record<string, unknown>>(
        c.req.param("slug"),
        c.req.param("table"),
        p,
      );
      return c.json(await handle.select(parsed.data.where));
    } catch (err) {
      rethrow(err);
    }
  });
}
