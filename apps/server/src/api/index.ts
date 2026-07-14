import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { principalContextSchema } from "@lithis/core";
import type { PrincipalContext } from "@lithis/core";
import { NotImplementedError, StubRegistry } from "@lithis/stubkit";
import type { ContextStore } from "../context";
import type { HumanGate } from "../humangate";
import type { WorkQueue } from "../work";
import type { ServerRole } from "../config";

/**
 * api — the HTTP surface. This module is REAL and load-bearing in the
 * skeleton: /health, /stubs (the live stub census the portal's
 * "What's real yet" panel renders), and the NotImplementedError → 501
 * { stubId, reason } mapping. The domain routes exist but call stubbed
 * services, so they answer 501 with the exact stub id that would need
 * implementing — structural honesty over silence.
 *
 * Full surface (every capability defined ONCE as a tool, served to
 * portal/chat/MCP + SSE) is deferred; see the stub census.
 */

export interface ApiDeps {
  role: ServerRole;
  humanGate: HumanGate;
  workQueue: WorkQueue;
  contextStore: ContextStore;
  /** Injectable for tests; defaults to construction time. */
  startedAtMs?: number;
}

/**
 * Dev-header identity: real auth is not part of the skeleton, so the caller
 * identifies via x-lithis-tenant / x-lithis-principal (ULIDs) and optional
 * x-lithis-principal-kind. Missing/invalid headers are a 400.
 */
export function principalFromHeaders(c: Context): PrincipalContext {
  const parsed = principalContextSchema.safeParse({
    tenantId: c.req.header("x-lithis-tenant"),
    principalId: c.req.header("x-lithis-principal"),
    kind: c.req.header("x-lithis-principal-kind") ?? "human",
  });
  if (!parsed.success) {
    throw new HTTPException(400, {
      message:
        "identify with x-lithis-tenant and x-lithis-principal headers (ULIDs); optional x-lithis-principal-kind human|agent|service",
    });
  }
  return parsed.data;
}

export function buildApp(deps: ApiDeps): Hono {
  const startedAtMs = deps.startedAtMs ?? Date.now();
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof NotImplementedError) {
      return c.json({ stubId: err.stubId, reason: err.reason }, 501);
    }
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    return c.json({ error: err.message }, 500);
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      role: deps.role,
      uptime: Math.round((Date.now() - startedAtMs) / 1000),
    }),
  );

  /** The live stub census — the portal's "What's real yet" panel reads this. */
  app.get("/stubs", (c) => c.json(StubRegistry.census()));

  // ── placeholder domain routes: they call the stubbed services and therefore
  //    answer 501 { stubId, reason } until the module behind them is built ──

  app.get("/api/humangate/inbox", async (c) => {
    const p = principalFromHeaders(c);
    return c.json(await deps.humanGate.inbox(p));
  });

  app.get("/api/work", async (c) => {
    const p = principalFromHeaders(c);
    return c.json(await deps.workQueue.claim(p, {}));
  });

  app.get("/api/context/search", async (c) => {
    const p = principalFromHeaders(c);
    const text = c.req.query("q");
    if (text === undefined || text.length === 0) {
      throw new HTTPException(400, { message: "missing required query parameter 'q'" });
    }
    return c.json(await deps.contextStore.search({ text }, p));
  });

  return app;
}
