/**
 * @lithis/portal — dev/serve entrypoint.
 *
 * REAL code: on boot, bundles the React UI (src/ui/main.tsx) with Bun.build and
 * serves it from memory. API traffic is proxied same-origin — /api/* and
 * /stubs (plus /server-health) forward to the lithis server, because the
 * server sets no CORS headers, so the browser cannot call it cross-origin.
 * The page injects `window.LITHIS_SERVER_URL` (display) and
 * `window.LITHIS_IDENTITY` (the dev-header identity from LITHIS_TENANT /
 * LITHIS_PRINCIPAL env). No data is faked here — every page talks to the real
 * server, and stubbed endpoints' 501 { stubId, reason } responses render as
 * first-class UI.
 */

import type { PortalIdentity } from "./ui/config";

export const DEFAULT_PORT = 4401;
export const DEFAULT_SERVER_URL = "http://localhost:4400";

/**
 * Dev identity for the x-lithis-tenant / x-lithis-principal headers, from
 * LITHIS_TENANT / LITHIS_PRINCIPAL (values printed by
 * `bun run --cwd apps/server src/iam/seed.ts`). Undefined when either is
 * missing — the UI then shows an identity-setup card instead of calling
 * endpoints that would answer 400.
 */
export function identityFromEnv(
  env: Record<string, string | undefined> = process.env,
): PortalIdentity | undefined {
  const tenantId = env["LITHIS_TENANT"];
  const principalId = env["LITHIS_PRINCIPAL"];
  if (tenantId === undefined || tenantId === "" || principalId === undefined || principalId === "") {
    return undefined;
  }
  return { tenantId, principalId };
}

/** Which portal paths forward to the lithis server. Pure — unit tested. */
export function isProxiedPath(pathname: string): boolean {
  return pathname === "/stubs" || pathname === "/server-health" || pathname.startsWith("/api/");
}

/** Render the single-page shell. Pure — unit tested. */
export function renderIndexHtml(serverUrl: string, identity?: PortalIdentity): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>lithis portal</title>
</head>
<body>
<div id="root"></div>
<script>
window.LITHIS_SERVER_URL = ${JSON.stringify(serverUrl)};
window.LITHIS_IDENTITY = ${JSON.stringify(identity ?? null)};
</script>
<script type="module" src="/app.js"></script>
</body>
</html>
`;
}

/**
 * Forward a request to the lithis server, preserving method/headers/body and
 * mapping /server-health to the server's /health. An unreachable server
 * becomes a 502 { error } so the UI renders an honest failure card.
 */
export async function proxyToServer(req: Request, serverUrl: string): Promise<Response> {
  const url = new URL(req.url);
  const targetPath = url.pathname === "/server-health" ? "/health" : url.pathname;
  const target = new URL(targetPath + url.search, serverUrl);
  const headers = new Headers(req.headers);
  headers.delete("host");
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer(),
      redirect: "manual",
    });
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: `portal: lithis server unreachable at ${serverUrl} — ${message}` },
      { status: 502 },
    );
  }
}

/** Bundle the browser UI. Returns the ESM bundle source. */
export async function buildUi(): Promise<string> {
  const entrypoint = new URL("./ui/main.tsx", import.meta.url).pathname;
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "browser",
    format: "esm",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!result.success) {
    const details = result.logs.map((log) => log.message).join("\n");
    throw new Error(`portal: UI bundle failed:\n${details}`);
  }
  const artifact = result.outputs[0];
  if (!artifact) {
    throw new Error("portal: UI bundle produced no output artifact");
  }
  return artifact.text();
}

export interface PortalOptions {
  port?: number;
  serverUrl?: string;
  /** Dev identity to inject; defaults to LITHIS_TENANT/LITHIS_PRINCIPAL env. */
  identity?: PortalIdentity;
}

export async function startPortal(options: PortalOptions = {}) {
  const serverUrl = options.serverUrl ?? process.env["LITHIS_SERVER_URL"] ?? DEFAULT_SERVER_URL;
  const port = options.port ?? Number(process.env["PORT"] ?? DEFAULT_PORT);
  const identity = options.identity ?? identityFromEnv();
  const bundle = await buildUi();
  const indexHtml = renderIndexHtml(serverUrl, identity);

  const server = Bun.serve({
    port,
    async fetch(req: Request): Promise<Response> {
      const { pathname } = new URL(req.url);
      if (pathname === "/" || pathname === "/index.html") {
        return new Response(indexHtml, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (pathname === "/app.js") {
        return new Response(bundle, {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      }
      if (pathname === "/healthz") {
        return new Response("ok");
      }
      if (isProxiedPath(pathname)) {
        return proxyToServer(req, serverUrl);
      }
      return new Response("not found", { status: 404 });
    },
  });

  console.log(
    `lithis portal listening on http://localhost:${server.port} (lithis server: ${serverUrl}; identity: ${identity ? `${identity.tenantId}/${identity.principalId}` : "NOT CONFIGURED — set LITHIS_TENANT and LITHIS_PRINCIPAL"})`,
  );
  return server;
}

if (import.meta.main) {
  await startPortal();
}
