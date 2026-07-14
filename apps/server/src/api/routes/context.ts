import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { ApiDeps } from "../deps";
import { principalFromHeaders } from "../identity";

/** Routes for the context module. Answers 501 { stubId } until it is built. */
export function mountContextRoutes(app: Hono, deps: ApiDeps): void {
  app.get("/api/context/search", async (c) => {
    const p = principalFromHeaders(c);
    const text = c.req.query("q");
    if (text === undefined || text.length === 0) {
      throw new HTTPException(400, { message: "missing required query parameter 'q'" });
    }
    return c.json(await deps.contextStore.search({ text }, p));
  });
}
