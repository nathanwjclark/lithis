import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Hono } from "hono";
import { audienceSchema, nowIso, slugSchema } from "@lithis/core";
import type { ApiDeps } from "../deps";
import { principalFromHeaders } from "../identity";

/**
 * Routes for the context module (REAL as of P4).
 *
 *  - GET  /api/context/search — hybrid search; audience defaults 'network'.
 *  - POST /api/context/docs   — text ingest convenience: putBlob + ingestDoc
 *    in one call (content lands quarantined by default, like everything else).
 */

const ingestBodySchema = z.object({
  type: slugSchema,
  slug: slugSchema,
  title: z.string().min(1),
  text: z.string().min(1),
  mediaType: z.string().min(1).default("text/plain"),
  frontmatter: z.record(z.unknown()).default({}),
  quarantined: z.boolean().optional(),
});

export function mountContextRoutes(app: Hono, deps: ApiDeps): void {
  app.get("/api/context/search", async (c) => {
    const p = principalFromHeaders(c);
    const text = c.req.query("q");
    if (text === undefined || text.length === 0) {
      throw new HTTPException(400, { message: "missing required query parameter 'q'" });
    }
    const audienceRaw = c.req.query("audience");
    const audience = audienceRaw === undefined ? undefined : audienceSchema.safeParse(audienceRaw);
    if (audience !== undefined && !audience.success) {
      throw new HTTPException(400, { message: "audience must be network|prospecting|all" });
    }
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
    if (limit !== undefined && (Number.isNaN(limit) || limit < 1)) {
      throw new HTTPException(400, { message: "limit must be a positive integer" });
    }
    const docTypes = c.req.queries("docType");
    const entityTypes = c.req.queries("entityType");
    return c.json(
      await deps.contextStore.search(
        {
          text,
          ...(audience !== undefined ? { audience: audience.data } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(docTypes !== undefined && docTypes.length > 0 ? { docTypes } : {}),
          ...(entityTypes !== undefined && entityTypes.length > 0 ? { entityTypes } : {}),
        },
        p,
      ),
    );
  });

  app.post("/api/context/docs", async (c) => {
    const p = principalFromHeaders(c);
    const parsed = ingestBodySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: `invalid ingest body: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      });
    }
    const body = parsed.data;
    // API-submitted content: an authenticated principal handed it over, so
    // provenance is human/internal — the DOC still lands quarantined.
    const origin = {
      by: { kind: "principal" as const, id: p.principalId },
      method: "human" as const,
      trust: "internal" as const,
      at: nowIso(),
    };
    const blobRef = await deps.contextStore.putBlob(
      { tenantId: p.tenantId, mediaType: body.mediaType, origin },
      new TextEncoder().encode(body.text),
    );
    const docRef = await deps.contextStore.ingestDoc({
      tenantId: p.tenantId,
      type: body.type,
      slug: body.slug,
      title: body.title,
      bodyBlobId: blobRef.id,
      frontmatter: body.frontmatter,
      origin,
      ...(body.quarantined !== undefined ? { quarantined: body.quarantined } : {}),
    });
    return c.json({ blob: blobRef, doc: docRef }, 201);
  });
}
