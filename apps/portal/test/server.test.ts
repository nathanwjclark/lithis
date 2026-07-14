import { afterAll, describe, expect, test } from "bun:test";
import {
  buildUi,
  DEFAULT_PORT,
  DEFAULT_SERVER_URL,
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

  test("injected url is JSON-escaped", () => {
    const html = renderIndexHtml('http://x/"</script>');
    expect(html).not.toContain('window.LITHIS_SERVER_URL = "http://x/"</script>');
    expect(html).toContain("\\\"");
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
  const serverPromise = startPortal({ port: 0, serverUrl: "http://localhost:4400" });

  afterAll(async () => {
    const server = await serverPromise;
    server.stop(true);
  });

  test("serves the shell and the built UI bundle", async () => {
    const server = await serverPromise;
    const base = `http://localhost:${server.port}`;

    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    const html = await index.text();
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain("window.LITHIS_SERVER_URL");

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
});
