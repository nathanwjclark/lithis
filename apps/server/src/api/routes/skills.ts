import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import { z } from "zod";
import {
  SKILL_KINDS,
  gitRefSchema,
  skillManifestSchema,
  slugSchema,
  ulidSchema,
} from "@lithis/core";
import { SkillChecksumMismatchError, SkillNotApprovedError } from "../../skills";
import type { SkillRegistry } from "../../skills";
import type { ApiDeps } from "../deps";
import { principalFromHeaders } from "../identity";

/**
 * Routes for the skills module (real as of P10-skills): propose a version
 * (opens the skill_change HumanRequest), activate an approved version
 * (409 on checksum mismatch / missing approval), list the tenant's skills,
 * and read a skill's durable run ledger. Identity comes from the dev headers;
 * tenancy always comes from the caller, never the body.
 */

const proposeBodySchema = z.object({
  slug: slugSchema,
  kind: z.enum(SKILL_KINDS),
  semver: z.string().regex(/^\d+\.\d+\.\d+$/),
  sourceRef: gitRefSchema,
  manifest: skillManifestSchema,
});

function registryOf(deps: ApiDeps): SkillRegistry {
  if (deps.skills === undefined) {
    throw new HTTPException(503, {
      message: "skill registry unavailable — server started without DATABASE_URL",
    });
  }
  return deps.skills;
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

export function mountSkillsRoutes(app: Hono, deps: ApiDeps): void {
  // Handler order everywhere: identity (400) → availability (503) → input (400).
  app.post("/api/skills/propose", async (c) => {
    const p = principalFromHeaders(c);
    const registry = registryOf(deps);
    const parsed = proposeBodySchema.safeParse(await jsonBody(c));
    if (!parsed.success) {
      throw new HTTPException(400, { message: parsed.error.message });
    }
    const result = await registry.propose({
      ...parsed.data,
      tenantId: p.tenantId,
      authoredBy: { kind: "principal", id: p.principalId },
    });
    return c.json(result, 201);
  });

  app.post("/api/skills/versions/:id/activate", async (c) => {
    const p = principalFromHeaders(c);
    const registry = registryOf(deps);
    const id = ulidSchema.safeParse(c.req.param("id"));
    if (!id.success) {
      throw new HTTPException(400, { message: "version id must be a ULID" });
    }
    try {
      await registry.activate(id.data, p.tenantId);
    } catch (err) {
      if (err instanceof SkillChecksumMismatchError || err instanceof SkillNotApprovedError) {
        throw new HTTPException(409, { message: err.message });
      }
      throw err;
    }
    return c.json({ activated: id.data });
  });

  app.get("/api/skills", async (c) => {
    const p = principalFromHeaders(c);
    return c.json(await registryOf(deps).list(p.tenantId));
  });

  app.get("/api/skills/:slug/runs", async (c) => {
    const p = principalFromHeaders(c);
    const registry = registryOf(deps);
    const slug = slugSchema.safeParse(c.req.param("slug"));
    if (!slug.success) {
      throw new HTTPException(400, { message: "slug must be a valid skill slug" });
    }
    return c.json(await registry.runsFor(p.tenantId, slug.data));
  });
}
