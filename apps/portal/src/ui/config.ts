/** Browser-side config injected by the portal server (see src/main.ts). */

declare global {
  interface Window {
    LITHIS_SERVER_URL?: string;
  }
}

export const FALLBACK_SERVER_URL = "http://localhost:4400";

/** Base URL of the lithis server API. */
export function serverUrl(): string {
  if (typeof window !== "undefined" && window.LITHIS_SERVER_URL) {
    return window.LITHIS_SERVER_URL;
  }
  return FALLBACK_SERVER_URL;
}
