import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { principalContextSchema } from "@lithis/core";
import type { PrincipalContext } from "@lithis/core";

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
