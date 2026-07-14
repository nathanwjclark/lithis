/**
 * @lithis/portal — dev/serve entrypoint.
 *
 * REAL code: on boot, bundles the React UI (src/ui/main.tsx) with Bun.build and
 * serves it from memory. The page injects `window.LITHIS_SERVER_URL` so the UI
 * knows where the lithis server API lives. No data is faked here — every page
 * talks to the real server and renders the server's registered-stub responses
 * (501 + { stubId, reason }) as first-class UI.
 */

export const DEFAULT_PORT = 4401;
export const DEFAULT_SERVER_URL = "http://localhost:4400";

/** Render the single-page shell. Pure — unit tested. */
export function renderIndexHtml(serverUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>lithis portal</title>
</head>
<body>
<div id="root"></div>
<script>window.LITHIS_SERVER_URL = ${JSON.stringify(serverUrl)};</script>
<script type="module" src="/app.js"></script>
</body>
</html>
`;
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
}

export async function startPortal(options: PortalOptions = {}) {
  const serverUrl = options.serverUrl ?? process.env["LITHIS_SERVER_URL"] ?? DEFAULT_SERVER_URL;
  const port = options.port ?? Number(process.env["PORT"] ?? DEFAULT_PORT);
  const bundle = await buildUi();
  const indexHtml = renderIndexHtml(serverUrl);

  const server = Bun.serve({
    port,
    fetch(req: Request): Response {
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
      return new Response("not found", { status: 404 });
    },
  });

  console.log(`lithis portal listening on http://localhost:${server.port} (lithis server: ${serverUrl})`);
  return server;
}

if (import.meta.main) {
  await startPortal();
}
