import type { Hono } from "hono";
import type { ApiDeps } from "../deps";
import { principalFromHeaders } from "../identity";

/** Routes for the humangate module. Answers 501 { stubId } until it is built. */
export function mountHumangateRoutes(app: Hono, deps: ApiDeps): void {
  app.get("/api/humangate/inbox", async (c) => {
    const p = principalFromHeaders(c);
    return c.json(await deps.humanGate.inbox(p));
  });
}
