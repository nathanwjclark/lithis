import { afterAll, describe, expect, test } from "bun:test";
import {
  buildUi,
  DEFAULT_PORT,
  DEFAULT_SERVER_URL,
  identityFromEnv,
  isProxiedPath,
  renderIndexHtml,
  startPortal,
} from "../src/main";
import { isStubbedResponse } from "../src/ui/api";

describe("module exports", () => {
  test("server module exports the expected surface", () => {
    expect(typeof startPortal).toBe("function");
    expect(typeof buildUi).toBe("function");
    expect(typeof renderIndexHtml).toBe("function");
    expect(DEFAULT_PORT).toBe(4401);
    expect(DEFAULT_SERVER_URL).toBe("http://localhost:4400");
  });
});

describe("renderIndexHtml", () => {
  test("emits root div, bundle script tag, and injected server url", () => {
    const html = renderIndexHtml("http://example.test:9999");
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<script type="module" src="/app.js"></script>');
    expect(html).toContain('window.LITHIS_SERVER_URL = "http://example.test:9999";');
  });

  test("injects the identity when given, null when not", () => {
    const withId = renderIndexHtml("http://x", { tenantId: "T1", principalId: "P1" });
    expect(withId).toContain('window.LITHIS_IDENTITY = {"tenantId":"T1","principalId":"P1"};');
    const without = renderIndexHtml("http://x");
    expect(without).toContain("window.LITHIS_IDENTITY = null;");
  });

  test("injected url is JSON-escaped", () => {
    const html = renderIndexHtml('http://x/"</script>');
    expect(html).not.toContain('window.LITHIS_SERVER_URL = "http://x/"</script>');
    expect(html).toContain("\\\"");
  });
});

describe("identityFromEnv", () => {
  test("reads LITHIS_TENANT / LITHIS_PRINCIPAL", () => {
    expect(identityFromEnv({ LITHIS_TENANT: "T", LITHIS_PRINCIPAL: "P" })).toEqual({
      tenantId: "T",
      principalId: "P",
    });
  });

  test("missing or empty values yield undefined", () => {
    expect(identityFromEnv({})).toBeUndefined();
    expect(identityFromEnv({ LITHIS_TENANT: "T" })).toBeUndefined();
    expect(identityFromEnv({ LITHIS_TENANT: "", LITHIS_PRINCIPAL: "P" })).toBeUndefined();
  });
});

describe("isProxiedPath", () => {
  test("api paths, /stubs and /server-health proxy; portal paths do not", () => {
    expect(isProxiedPath("/api/humangate/inbox")).toBe(true);
    expect(isProxiedPath("/api/context/search")).toBe(true);
    expect(isProxiedPath("/stubs")).toBe(true);
    expect(isProxiedPath("/server-health")).toBe(true);
    expect(isProxiedPath("/")).toBe(false);
    expect(isProxiedPath("/app.js")).toBe(false);
    expect(isProxiedPath("/healthz")).toBe(false);
    expect(isProxiedPath("/apis")).toBe(false);
  });
});

describe("isStubbedResponse", () => {
  test("accepts { stubId, reason } bodies and rejects others", () => {
    expect(isStubbedResponse({ stubId: "server.humangate.inbox", reason: "LITHIS-STUB: x" })).toBe(
      true,
    );
    expect(isStubbedResponse({ stubId: 5, reason: "x" })).toBe(false);
    expect(isStubbedResponse(null)).toBe(false);
    expect(isStubbedResponse("nope")).toBe(false);
  });
});

describe("startPortal (real boot on an ephemeral port)", () => {
  // Fixture upstream standing in for the lithis server — fixture data in
  // tests is exactly where it belongs.
  const upstream = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const { pathname, searchParams } = new URL(req.url);
      if (pathname === "/stubs") {
        return Response.json({ total: 0, invoked: 0, records: [] });
      }
      if (pathname === "/health") {
        return Response.json({ ok: true });
      }
      if (pathname === "/api/echo") {
        return Response.json({
          method: req.method,
          tenant: req.headers.get("x-lithis-tenant"),
          principal: req.headers.get("x-lithis-principal"),
          q: searchParams.get("q"),
          body: req.method === "POST" ? await req.json() : null,
        });
      }
      return new Response("upstream: not found", { status: 404 });
    },
  });

  const serverPromise = startPortal({
    port: 0,
    serverUrl: `http://localhost:${upstream.port}`,
    identity: { tenantId: "T-TEST", principalId: "P-TEST" },
  });

  afterAll(async () => {
    const server = await serverPromise;
    server.stop(true);
    upstream.stop(true);
  });

  test("serves the shell and the built UI bundle", async () => {
    const server = await serverPromise;
    const base = `http://localhost:${server.port}`;

    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    const html = await index.text();
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain("window.LITHIS_SERVER_URL");
    expect(html).toContain('window.LITHIS_IDENTITY = {"tenantId":"T-TEST","principalId":"P-TEST"}');

    const bundle = await fetch(`${base}/app.js`);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-type")).toContain("javascript");
    const js = await bundle.text();
    expect(js.length).toBeGreaterThan(1000);
    // The real UI made it into the bundle — honesty strings from the pages.
    expect(js).toContain("Inbox zero");
    expect(js).toContain("What");

    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
  });

  test("proxies /stubs and /api/* to the lithis server, preserving method/headers/query/body", async () => {
    const server = await serverPromise;
    const base = `http://localhost:${server.port}`;

    const stubs = await fetch(`${base}/stubs`);
    expect(stubs.status).toBe(200);
    expect(await stubs.json()).toEqual({ total: 0, invoked: 0, records: [] });

    const echo = await fetch(`${base}/api/echo?q=loss+runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lithis-tenant": "T-TEST",
        "x-lithis-principal": "P-TEST",
      },
      body: JSON.stringify({ verdict: "approved", comment: "" }),
    });
    expect(echo.status).toBe(200);
    expect(await echo.json()).toEqual({
      method: "POST",
      tenant: "T-TEST",
      principal: "P-TEST",
      q: "loss runs",
      body: { verdict: "approved", comment: "" },
    });

    const health = await fetch(`${base}/server-health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const upstream404 = await fetch(`${base}/api/nope`);
    expect(upstream404.status).toBe(404);
  });

  test("an unreachable lithis server answers 502 with an honest error body", async () => {
    const dead = await startPortal({
      port: 0,
      serverUrl: "http://localhost:1",
      identity: { tenantId: "T", principalId: "P" },
    });
    try {
      const res = await fetch(`http://localhost:${dead.port}/api/humangate/inbox`);
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("unreachable");
    } finally {
      dead.stop(true);
    }
  });
});
