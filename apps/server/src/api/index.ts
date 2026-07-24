import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { NotImplementedError, StubRegistry } from "@lithis/stubkit";
import type { ApiDeps } from "./deps";
import { mountArtifactsRoutes } from "./routes/artifacts";
import { mountContextRoutes } from "./routes/context";
import { mountDeliveryRoutes } from "./routes/delivery";
import { mountHumangateRoutes } from "./routes/humangate";
import { mountSkillsRoutes } from "./routes/skills";
import { mountSorRoutes } from "./routes/sor";
import { mountWorkRoutes } from "./routes/work";

/**
 * api — the HTTP surface. This module is REAL and load-bearing in the
 * skeleton: /health, /stubs (the live stub census the portal's
 * "What's real yet" panel renders), and the NotImplementedError → 501
 * { stubId, reason } mapping. Domain routes live in ./routes/<module>.ts —
 * one file per server module so parallel phases never collide here — and
 * answer 501 with the exact stub id until the module behind them is built.
 *
 * Full surface (every capability defined ONCE as a tool, served to
 * portal/chat/MCP + SSE) is deferred; see the stub census.
 */

export type { ApiDeps } from "./deps";
export { principalFromHeaders } from "./identity";

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

  mountHumangateRoutes(app, deps);
  mountWorkRoutes(app, deps);
  mountContextRoutes(app, deps);
  mountDeliveryRoutes(app, deps);
  mountSkillsRoutes(app, deps);
  mountArtifactsRoutes(app, deps);
  mountSorRoutes(app, deps);

  return app;
}
