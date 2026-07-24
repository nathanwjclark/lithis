import { describe, expect, test } from "bun:test";
import {
  CHROME_BINARY_ENV,
  DEFAULT_CHROME_BINARIES,
  chromeLaunchArgs,
  parseDevToolsEndpoint,
  resolveChromeBinary,
} from "../src/index";

describe("parseDevToolsEndpoint", () => {
  test("pulls the ws endpoint out of Chrome's stderr banner", () => {
    const stderr =
      "[1234:5678:0724/090000.123456:ERROR:whatever] noise\n" +
      "DevTools listening on ws://127.0.0.1:51234/devtools/browser/8f1c-4b2d\n";
    expect(parseDevToolsEndpoint(stderr)).toBe(
      "ws://127.0.0.1:51234/devtools/browser/8f1c-4b2d",
    );
  });

  test("returns undefined until the banner arrives (partial stderr)", () => {
    expect(parseDevToolsEndpoint("DevTools listen")).toBeUndefined();
    expect(parseDevToolsEndpoint("")).toBeUndefined();
  });
});

describe("chromeLaunchArgs", () => {
  test("asks for an ephemeral debug port against the pod's user-data-dir", () => {
    const args = chromeLaunchArgs("/tmp/pods/session-abc");
    expect(args).toContain("--remote-debugging-port=0");
    expect(args).toContain("--user-data-dir=/tmp/pods/session-abc");
  });

  test("never runs headless and never spoofs a fingerprint", () => {
    const args = chromeLaunchArgs("/tmp/pod").join(" ");
    expect(args).not.toContain("--headless");
    expect(args).not.toContain("--user-agent");
    expect(args).not.toContain("--disable-blink-features=AutomationControlled");
  });
});

describe("resolveChromeBinary", () => {
  test("LITHIS_CHROME_BINARY wins when it exists", () => {
    const path = resolveChromeBinary({
      env: { [CHROME_BINARY_ENV]: "/opt/custom/chrome" },
      exists: (p) => p === "/opt/custom/chrome",
    });
    expect(path).toBe("/opt/custom/chrome");
  });

  test("a configured-but-missing binary fails loudly, naming the env var", () => {
    expect(() =>
      resolveChromeBinary({ env: { [CHROME_BINARY_ENV]: "/nope/chrome" }, exists: () => false }),
    ).toThrow(/LITHIS_CHROME_BINARY points at '\/nope\/chrome'/);
  });

  test("falls back to the first existing standard install path", () => {
    const target = DEFAULT_CHROME_BINARIES[DEFAULT_CHROME_BINARIES.length - 1]!;
    expect(resolveChromeBinary({ env: {}, exists: (p) => p === target })).toBe(target);
  });

  test("no Chrome anywhere is a loud configuration error, not a silent degrade", () => {
    expect(() => resolveChromeBinary({ env: {}, exists: () => false })).toThrow(
      /no Chrome\/Chromium binary found/,
    );
  });
});
