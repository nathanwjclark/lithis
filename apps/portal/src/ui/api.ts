/**
 * Browser-side calls to the lithis server — REAL fetch code, same-origin
 * (the portal server proxies /api/* and /stubs to the lithis server). Failure
 * modes are first-class values, never hidden:
 *
 *  - 501 { stubId, reason }  → a registered-stub card (the endpoint is a
 *    declared stub on the server).
 *  - 503                     → module unavailable (e.g. server booted without
 *    DATABASE_URL) — a config condition, not a stub.
 *  - anything else non-2xx   → an honest HTTP error card.
 */

import type { StubCensus } from "@lithis/stubkit";
import type { PortalIdentity } from "./config";

/** Body shape the server returns for a registered-stub endpoint (HTTP 501). */
export interface StubbedResponse {
  stubId: string;
  reason: string;
}

export function isStubbedResponse(value: unknown): value is StubbedResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["stubId"] === "string" && typeof record["reason"] === "string";
}

/** Every way an API call can fail, as data the UI renders honestly. */
export type ApiFailure =
  | { kind: "stub"; stub: StubbedResponse }
  | { kind: "unavailable"; message: string }
  | { kind: "http"; status: number; message: string }
  | { kind: "network"; message: string };

export type ApiResult<T> = { ok: true; data: T } | { ok: false; failure: ApiFailure };

/** Best human-readable message out of a non-2xx body. Pure — unit tested. */
export function failureMessage(status: number, rawBody: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed === "object" && parsed !== null) {
    const error = (parsed as Record<string, unknown>)["error"];
    if (typeof error === "string" && error.length > 0) return error;
    const message = (parsed as Record<string, unknown>)["message"];
    if (typeof message === "string" && message.length > 0) return message;
  }
  const trimmed = rawBody.trim();
  if (trimmed.length > 0 && parsed === undefined) return trimmed;
  return `HTTP ${status}`;
}

/** Classify a non-2xx response into an ApiFailure. Pure — unit tested. */
export function classifyFailure(status: number, rawBody: string): ApiFailure {
  if (status === 501) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      parsed = undefined;
    }
    if (isStubbedResponse(parsed)) return { kind: "stub", stub: parsed };
  }
  const message = failureMessage(status, rawBody);
  if (status === 503) return { kind: "unavailable", message };
  return { kind: "http", status, message };
}

/**
 * Fetch a same-origin API path with the dev identity headers attached,
 * returning parsed JSON or a classified failure. Never throws.
 */
export async function apiFetch<T>(
  path: string,
  identity: PortalIdentity,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        "x-lithis-tenant": identity.tenantId,
        "x-lithis-principal": identity.principalId,
      },
    });
  } catch (err: unknown) {
    return {
      ok: false,
      failure: { kind: "network", message: err instanceof Error ? err.message : String(err) },
    };
  }
  if (!res.ok) {
    return { ok: false, failure: classifyFailure(res.status, await res.text()) };
  }
  return { ok: true, data: (await res.json()) as T };
}

/** Fetch the live stub census (no identity required). Throws on non-2xx. */
export async function fetchCensus(baseUrl: string): Promise<StubCensus> {
  const res = await fetch(`${baseUrl}/stubs`);
  if (!res.ok) {
    throw new Error(`GET ${baseUrl}/stubs responded ${res.status}`);
  }
  return (await res.json()) as StubCensus;
}
