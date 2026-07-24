/**
 * The CDP broker's method policy — the concrete expression of ADR-003.
 *
 * A mounted browser session holds a real logged-in profile. Cookie material
 * must never leave the pod, so the broker speaks an ALLOW-LIST: only the
 * methods the SDK's BrowserSession actually needs get forwarded, and a
 * separate hard DENY-list overrides the allow-list for every method that reads
 * or writes profile material (cookies, DOM/IndexedDB/CacheStorage storage,
 * request interception, devtools escape hatches). Deny always wins.
 *
 * Residual risk, stated honestly: `Runtime.evaluate` is on the allow-list
 * because navigating and extracting requires page scripting, and page script
 * can read JS-visible (non-httpOnly) cookies. The expression guard below is
 * defense in depth against the obvious `document.cookie` exfiltration, NOT a
 * sandbox — a fine-grained expression/capability policy is policy-layer work
 * (ADR-006 / TODOS.md). Session cookies that matter (LinkedIn's li_at, most
 * portal auth) are httpOnly and are unreachable from page script by
 * construction; the wholesale profile-export paths are what this file closes.
 */

/**
 * Methods that are ALWAYS denied, whatever else says. Every one of these
 * either returns profile material directly or is a general-purpose channel to
 * get at it.
 */
export const CDP_DENIED_METHODS: readonly string[] = [
  // Cookies — the exact threat ADR-003 exists to prevent.
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
  "Page.clearBrowserCookies",
  // Origin-scoped storage: localStorage/sessionStorage/IndexedDB/CacheStorage.
  "DOMStorage.getDOMStorageItems",
  "DOMStorage.setDOMStorageItem",
  "DOMStorage.removeDOMStorageItem",
  "DOMStorage.clear",
  "DOMStorage.enable",
  "IndexedDB.requestData",
  "IndexedDB.requestDatabase",
  "IndexedDB.requestDatabaseNames",
  "IndexedDB.getMetadata",
  "CacheStorage.requestCacheNames",
  "CacheStorage.requestEntries",
  "CacheStorage.requestCachedResponse",
  "Storage.clearDataForOrigin",
  "Storage.getStorageKeyForFrame",
  "Storage.getUsageAndQuota",
  "Storage.getTrustTokens",
  "Storage.getInterestGroupDetails",
  "Storage.getSharedStorageEntries",
  // Header/credential surfaces and request interception (Set-Cookie rides here).
  "Network.setExtraHTTPHeaders",
  "Network.getRequestPostData",
  "Network.getResponseBodyForInterception",
  "Network.takeResponseBodyForInterceptionAsStream",
  "Network.continueInterceptedRequest",
  "Network.setRequestInterception",
  "Fetch.enable",
  "Fetch.continueRequest",
  "Fetch.continueWithAuth",
  "Fetch.getResponseBody",
  "Fetch.takeResponseBodyAsStream",
  "Fetch.fulfillRequest",
  // Escape hatches out of the brokered channel or off the sealed profile.
  "Target.exposeDevToolsProtocol",
  "Target.createBrowserContext",
  "Target.disposeBrowserContext",
  "Browser.setDownloadBehavior",
  "Page.setDownloadBehavior",
  "Browser.getBrowserCommandLine",
  "Browser.close",
  "SystemInfo.getInfo",
  "Security.setIgnoreCertificateErrors",
  "Page.setBypassCSP",
];

const DENIED = new Set(CDP_DENIED_METHODS);

/**
 * Anything in these CDP domains is denied even if a new method name appears in
 * a future Chrome — the deny-list must not silently shrink as Chrome grows.
 */
export const CDP_DENIED_DOMAINS: readonly string[] = [
  "DOMStorage",
  "IndexedDB",
  "CacheStorage",
  "Fetch",
  "Preload",
  "DeviceAccess",
  "FedCm",
  "WebAuthn",
];

const DENIED_DOMAINS = new Set(CDP_DENIED_DOMAINS);

/** Any method whose name talks about cookies is denied, whatever its domain. */
const COOKIE_NAME = /cookie/i;

/**
 * The methods the SDK BrowserSession needs: navigate, evaluate/extract, click,
 * screenshot evidence, and the target plumbing to reach a page from the
 * browser-level endpoint.
 */
export const CDP_ALLOWED_METHODS: readonly string[] = [
  "Page.enable",
  "Page.disable",
  "Page.navigate",
  "Page.reload",
  "Page.getFrameTree",
  "Page.getNavigationHistory",
  "Page.captureScreenshot",
  "Page.bringToFront",
  "Runtime.enable",
  "Runtime.disable",
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Runtime.getProperties",
  "Runtime.releaseObject",
  "DOM.enable",
  "DOM.getDocument",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.describeNode",
  "DOM.resolveNode",
  "DOM.getBoxModel",
  "DOM.getAttributes",
  "DOM.focus",
  "DOM.scrollIntoViewIfNeeded",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Target.getTargets",
  "Target.getTargetInfo",
  "Target.attachToTarget",
  "Target.detachFromTarget",
  "Target.setDiscoverTargets",
  "Target.setAutoAttach",
  "Target.createTarget",
  "Target.closeTarget",
  "Target.activateTarget",
];

const ALLOWED = new Set(CDP_ALLOWED_METHODS);

/** Script fragments that would read profile material straight out of the page. */
const SCRIPT_PROFILE_MATERIAL =
  /\b(document\s*\.\s*cookie|localStorage|sessionStorage|indexedDB|caches\b|navigator\s*\.\s*credentials|cookieStore)/;

export type CdpDenyRule = "denied_method" | "not_allow_listed" | "denied_script";

export type CdpDecision =
  | { allow: true }
  | { allow: false; rule: CdpDenyRule; reason: string };

/** Method-name policy only (deny-list ∪ allow-list). */
export function decideCdpMethod(method: string): CdpDecision {
  const domain = method.slice(0, Math.max(0, method.indexOf(".")));
  if (DENIED.has(method) || DENIED_DOMAINS.has(domain) || COOKIE_NAME.test(method)) {
    return {
      allow: false,
      rule: "denied_method",
      reason:
        `CDP method '${method}' is hard-denied by the browserhost broker: it reads or writes ` +
        `sealed profile material. Browser sessions are custody assets (ADR-003) — cookies never ` +
        `leave the pod.`,
    };
  }
  if (!ALLOWED.has(method)) {
    return {
      allow: false,
      rule: "not_allow_listed",
      reason:
        `CDP method '${method}' is not on the browserhost broker allow-list. The broker forwards ` +
        `only the navigate/extract/click/screenshot surface; ask for an explicit allow-list entry ` +
        `rather than widening the channel.`,
    };
  }
  return { allow: true };
}

/** What a CDP command looks like on the wire (id + method + optional params). */
export interface CdpCommand {
  id?: number;
  method?: unknown;
  params?: unknown;
  sessionId?: string;
}

/**
 * Full command policy: method name first, then a defense-in-depth scan of
 * script payloads for direct profile-material reads. See the file header for
 * exactly how much this guarantee is worth.
 */
export function decideCdpCommand(command: CdpCommand): CdpDecision {
  const method = command.method;
  if (typeof method !== "string" || method.length === 0) {
    return {
      allow: false,
      rule: "not_allow_listed",
      reason: "CDP command carried no method name — the broker forwards only well-formed commands.",
    };
  }
  const byMethod = decideCdpMethod(method);
  if (!byMethod.allow) return byMethod;

  if (method === "Runtime.evaluate" || method === "Runtime.callFunctionOn") {
    const params = (command.params ?? {}) as Record<string, unknown>;
    const script = [params["expression"], params["functionDeclaration"]]
      .filter((v): v is string => typeof v === "string")
      .join("\n");
    if (SCRIPT_PROFILE_MATERIAL.test(script)) {
      return {
        allow: false,
        rule: "denied_script",
        reason:
          `'${method}' script references profile material (cookies / local or session storage / ` +
          `IndexedDB / credentials). Sealed-session material never leaves the pod (ADR-003).`,
      };
    }
  }
  return { allow: true };
}

/** The CDP error object returned to a caller whose command was refused. */
export function cdpDenialError(decision: Extract<CdpDecision, { allow: false }>): {
  code: number;
  message: string;
  data: string;
} {
  return { code: -32601, message: decision.reason, data: decision.rule };
}
