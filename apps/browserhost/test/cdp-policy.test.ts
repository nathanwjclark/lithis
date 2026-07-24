import { describe, expect, test } from "bun:test";
import {
  CDP_ALLOWED_METHODS,
  CDP_DENIED_METHODS,
  cdpDenialError,
  decideCdpCommand,
  decideCdpMethod,
} from "../src/index";

/**
 * The deny-list is the single most security-relevant thing in browserhost:
 * cookie exfiltration through CDP is exactly what ADR-003 exists to prevent.
 */
describe("CDP deny-list", () => {
  const cookieMethods = [
    "Network.getAllCookies",
    "Network.getCookies",
    "Network.setCookie",
    "Network.setCookies",
    "Network.deleteCookies",
    "Network.clearBrowserCookies",
    "Storage.getCookies",
    "Storage.setCookies",
    "Storage.clearCookies",
    "Page.getCookies",
    "Page.setCookie",
  ];

  for (const method of cookieMethods) {
    test(`${method} is hard-denied`, () => {
      const decision = decideCdpMethod(method);
      expect(decision.allow).toBe(false);
      if (decision.allow) throw new Error("unreachable");
      expect(decision.rule).toBe("denied_method");
      expect(decision.reason).toContain(method);
    });
  }

  test("every listed denied method decides denied_method", () => {
    for (const method of CDP_DENIED_METHODS) {
      const decision = decideCdpMethod(method);
      expect(decision.allow).toBe(false);
      if (decision.allow) throw new Error("unreachable");
      expect(decision.rule).toBe("denied_method");
    }
  });

  test("unknown cookie-ish methods added by future Chromes are denied by name", () => {
    for (const method of ["Network.getCookiesForUrl", "Storage.setCookieJar", "Foo.readCookie"]) {
      const decision = decideCdpMethod(method);
      expect(decision.allow).toBe(false);
      if (decision.allow) throw new Error("unreachable");
      expect(decision.rule).toBe("denied_method");
    }
  });

  test("whole storage/interception domains are denied, not merely unlisted", () => {
    for (const method of [
      "DOMStorage.getDOMStorageItems",
      "IndexedDB.requestData",
      "CacheStorage.requestEntries",
      "Fetch.getResponseBody",
      "WebAuthn.getCredentials",
    ]) {
      const decision = decideCdpMethod(method);
      expect(decision.allow).toBe(false);
      if (decision.allow) throw new Error("unreachable");
      expect(decision.rule).toBe("denied_method");
    }
  });

  test("the deny-list and allow-list never overlap", () => {
    const allowed = new Set(CDP_ALLOWED_METHODS);
    for (const denied of CDP_DENIED_METHODS) expect(allowed.has(denied)).toBe(false);
    for (const method of CDP_ALLOWED_METHODS) expect(decideCdpMethod(method).allow).toBe(true);
  });
});

describe("CDP allow-list", () => {
  test("the navigate/extract/click/screenshot surface is allowed", () => {
    for (const method of [
      "Page.navigate",
      "Page.enable",
      "Page.captureScreenshot",
      "Runtime.evaluate",
      "Runtime.callFunctionOn",
      "Input.dispatchMouseEvent",
      "Target.attachToTarget",
    ]) {
      expect(decideCdpMethod(method).allow).toBe(true);
    }
  });

  test("anything else is refused as not_allow_listed", () => {
    for (const method of ["Emulation.setUserAgentOverride", "Debugger.enable", "Profiler.start"]) {
      const decision = decideCdpMethod(method);
      expect(decision.allow).toBe(false);
      if (decision.allow) throw new Error("unreachable");
      expect(decision.rule).toBe("not_allow_listed");
    }
  });

  test("a command without a method name is refused", () => {
    const decision = decideCdpCommand({ id: 1 });
    expect(decision.allow).toBe(false);
  });
});

describe("script-payload guard (defense in depth)", () => {
  test("Runtime.evaluate reading document.cookie is denied", () => {
    const decision = decideCdpCommand({
      id: 3,
      method: "Runtime.evaluate",
      params: { expression: "document.cookie" },
    });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error("unreachable");
    expect(decision.rule).toBe("denied_script");
  });

  test("localStorage / indexedDB / credentials reads are denied too", () => {
    for (const expression of [
      "JSON.stringify(localStorage)",
      "window.sessionStorage.getItem('x')",
      "indexedDB.databases()",
      "navigator.credentials.get({})",
    ]) {
      const decision = decideCdpCommand({ method: "Runtime.evaluate", params: { expression } });
      expect(decision.allow).toBe(false);
    }
  });

  test("callFunctionOn declarations are scanned as well", () => {
    const decision = decideCdpCommand({
      method: "Runtime.callFunctionOn",
      params: { functionDeclaration: "function(){ return document.cookie; }" },
    });
    expect(decision.allow).toBe(false);
  });

  test("ordinary extraction script is allowed", () => {
    const decision = decideCdpCommand({
      method: "Runtime.evaluate",
      params: { expression: "document.querySelector('[data-anonymize=\"person-name\"]').textContent" },
    });
    expect(decision.allow).toBe(true);
  });
});

describe("cdpDenialError", () => {
  test("carries the rule as data so callers can distinguish policy from protocol errors", () => {
    const decision = decideCdpMethod("Network.getAllCookies");
    if (decision.allow) throw new Error("unreachable");
    const error = cdpDenialError(decision);
    expect(error.code).toBe(-32601);
    expect(error.data).toBe("denied_method");
    expect(error.message).toContain("ADR-003");
  });
});
