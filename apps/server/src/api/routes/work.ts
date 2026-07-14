import type { Hono } from "hono";
import type { ApiDeps } from "../deps";
import { principalFromHeaders } from "../identity";

/** Routes for the work module. Answers 501 { stubId } until it is built. */
export function mountWorkRoutes(app: Hono, deps: ApiDeps): void {
  app.get("/api/work", async (c) => {
    const p = principalFromHeaders(c);
    return c.json(await deps.workQueue.claim(p, {}));
  });
}
