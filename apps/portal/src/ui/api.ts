/**
 * Browser-side calls to the lithis server. REAL fetch code — the endpoints it
 * hits are stubbed on the server side, and a 501 { stubId, reason } response is
 * rendered as a first-class "registered stub" card, never hidden.
 */

import type { StubCensus } from "@lithis/stubkit";

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

/** Fetch the live stub census from the server. Throws on non-2xx. */
export async function fetchCensus(baseUrl: string): Promise<StubCensus> {
  const res = await fetch(`${baseUrl}/stubs`);
  if (!res.ok) {
    throw new Error(`GET ${baseUrl}/stubs responded ${res.status}`);
  }
  return (await res.json()) as StubCensus;
}
