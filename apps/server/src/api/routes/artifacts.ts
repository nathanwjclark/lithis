import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import { z } from "zod";
import { TEMPLATE_KINDS, slugSchema, templateCheckSchema, ulidSchema } from "@lithis/core";
import {
  ArtifactNotFoundError,
  FieldsSchemaUnsupportedError,
  FieldsValidationError,
  TemplateNotApprovedError,
  TemplateNotFoundError,
  TemplateRenderError,
} from "../../artifacts";
import type { ArtifactEngine } from "../../artifacts";
import type { ApiDeps } from "../deps";
import { principalFromHeaders } from "../identity";

/**
 * Routes for the artifacts module (real as of P11): register a template
 * version (opens the template_change gate), list/read templates, render an
 * artifact from validated inputs, and run verification. Identity comes from
 * the dev headers; tenancy always comes from the caller, never the body.
 *
 * Error mapping is deliberate: a render that fails because the inputs or the
 * template are wrong is a 400 (the caller can fix it), an unapproved template
 * is a 409 (a human must act), and the image/video stub keeps its 501
 * { stubId, reason } through the app-level NotImplementedError handler.
 */

const createTemplateBodySchema = z.object({
  slug: slugSchema,
  version: z.string().min(1),
  kind: z.enum(TEMPLATE_KINDS),
  fieldsSchema: z.record(z.unknown()),
  bodyBlobId: ulidSchema,
  checks: z.array(templateCheckSchema).optional(),
  approvalPolicy: z.enum(["none", "always"]).optional(),
});

const renderBodySchema = z.object({
  templateId: ulidSchema,
  version: z.string().min(1),
  inputs: z.unknown(),
});

function engineOf(deps: ApiDeps): ArtifactEngine {
  if (deps.artifacts === undefined) {
    throw new HTTPException(503, {
      message: "artifact engine unavailable — server started without DATABASE_URL",
    });
  }
  return deps.artifacts;
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

/** Map engine errors onto status codes without swallowing any of them. */
function rethrow(err: unknown): never {
  if (
    err instanceof FieldsValidationError ||
    err instanceof FieldsSchemaUnsupportedError ||
    err instanceof TemplateRenderError
  ) {
    throw new HTTPException(400, { message: err.message });
  }
  if (err instanceof TemplateNotFoundError || err instanceof ArtifactNotFoundError) {
    throw new HTTPException(404, { message: err.message });
  }
  if (err instanceof TemplateNotApprovedError) {
    throw new HTTPException(409, { message: err.message });
  }
  throw err;
}

export function mountArtifactsRoutes(app: Hono, deps: ApiDeps): void {
  // Handler order everywhere: identity (400) → availability (503) → input (400).
  app.post("/api/artifacts/templates", async (c) => {
    const p = principalFromHeaders(c);
    const engine = engineOf(deps);
    const parsed = createTemplateBodySchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw new HTTPException(400, { message: parsed.error.message });
    try {
      const { checks, approvalPolicy, ...rest } = parsed.data;
      const result = await engine.createTemplate(
        {
          ...rest,
          tenantId: p.tenantId,
          ...(checks !== undefined ? { checks } : {}),
          ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
        },
        p,
      );
      return c.json(result, 201);
    } catch (err) {
      rethrow(err);
    }
  });

  app.get("/api/artifacts/templates", async (c) => {
    const p = principalFromHeaders(c);
    return c.json(await engineOf(deps).listTemplates(p.tenantId));
  });

  app.get("/api/artifacts/templates/:id", async (c) => {
    const p = principalFromHeaders(c);
    const engine = engineOf(deps);
    const id = ulidSchema.safeParse(c.req.param("id"));
    if (!id.success) throw new HTTPException(400, { message: "template id must be a ULID" });
    const template = await engine.getTemplate(id.data, p.tenantId);
    if (template === undefined) throw new HTTPException(404, { message: "template not found" });
    return c.json(template);
  });

  app.post("/api/artifacts/render", async (c) => {
    const p = principalFromHeaders(c);
    const engine = engineOf(deps);
    const parsed = renderBodySchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw new HTTPException(400, { message: parsed.error.message });
    try {
      const rendered = await engine.render(
        { id: parsed.data.templateId, version: parsed.data.version },
        parsed.data.inputs,
        p,
      );
      return c.json(rendered, 201);
    } catch (err) {
      rethrow(err);
    }
  });

  app.get("/api/artifacts/:id", async (c) => {
    const p = principalFromHeaders(c);
    const engine = engineOf(deps);
    const id = ulidSchema.safeParse(c.req.param("id"));
    if (!id.success) throw new HTTPException(400, { message: "artifact id must be a ULID" });
    const artifact = await engine.getArtifact(id.data, p.tenantId);
    if (artifact === undefined) throw new HTTPException(404, { message: "artifact not found" });
    return c.json(artifact);
  });

  app.post("/api/artifacts/:id/verify", async (c) => {
    const p = principalFromHeaders(c);
    const engine = engineOf(deps);
    const id = ulidSchema.safeParse(c.req.param("id"));
    if (!id.success) throw new HTTPException(400, { message: "artifact id must be a ULID" });
    try {
      return c.json(await engine.verify(id.data, p));
    } catch (err) {
      rethrow(err);
    }
  });
}
