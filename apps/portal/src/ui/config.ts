/** Browser-side config injected by the portal server (see src/main.ts). */

/**
 * Dev-header identity the UI attaches to /api calls (the server's
 * x-lithis-tenant / x-lithis-principal auth). Injected at page render from the
 * portal server's LITHIS_TENANT / LITHIS_PRINCIPAL env; null when not
 * configured — the UI then shows a configuration card instead of calling
 * endpoints that would answer 400.
 */
export interface PortalIdentity {
  tenantId: string;
  principalId: string;
}

declare global {
  interface Window {
    LITHIS_SERVER_URL?: string;
    LITHIS_IDENTITY?: PortalIdentity | null;
  }
}

export const FALLBACK_SERVER_URL = "http://localhost:4400";

/**
 * Base URL of the lithis server API — display only. Browser fetches go
 * same-origin: the portal server proxies /api/* and /stubs to this URL
 * (the lithis server sets no CORS headers, so a direct cross-origin fetch
 * would be blocked).
 */
export function serverUrl(): string {
  if (typeof window !== "undefined" && window.LITHIS_SERVER_URL) {
    return window.LITHIS_SERVER_URL;
  }
  return FALLBACK_SERVER_URL;
}

/** The injected dev identity, or undefined when the portal ran without one. */
export function identity(): PortalIdentity | undefined {
  if (typeof window !== "undefined" && window.LITHIS_IDENTITY) {
    return window.LITHIS_IDENTITY;
  }
  return undefined;
}
