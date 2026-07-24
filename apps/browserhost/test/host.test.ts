import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUlid } from "@lithis/core";
import { UnknownSessionError, createBrowserHostService, defaultHumanizationPolicy } from "../src/index";
import type { BrowserHostEvent, ChromeLaunchHandle, ChromeLauncher } from "../src/index";

/**
 * Pod-runtime behavior with a FAKE Chrome launcher — the suite never requires
 * a browser. What matters here is the custody contract: unseal into a fresh
 * pod dir, re-seal on release, and never leave profile bytes lying around.
 */

interface FakeLauncher extends ChromeLauncher {
  launches: string[];
  closed: number;
}

function fakeLauncher(wsEndpoint = "ws://127.0.0.1:9999/devtools/browser/fake"): FakeLauncher {
  const launcher: FakeLauncher = {
    launches: [],
    closed: 0,
    async launch({ userDataDir }): Promise<ChromeLaunchHandle> {
      launcher.launches.push(userDataDir);
      return {
        wsEndpoint,
        userDataDir,
        async close(): Promise<void> {
          launcher.closed += 1;
        },
      };
    },
  };
  return launcher;
}

describe("BrowserHostService (real pod runtime)", () => {
  let root: string;
  let sealed: string;
  let podRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "browserhost-test-"));
    sealed = join(root, "sealed");
    podRoot = join(root, "pods");
    await Bun.write(join(sealed, "Default", "Cookies"), "sealed-cookie-bytes");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("mount unseals the profile into a fresh pod dir and launches Chrome there", async () => {
    const launcher = fakeLauncher();
    const host = createBrowserHostService({ launcher, podRoot, podId: "pod-test" });
    const credentialRef = newUlid();

    const handle = await host.mountSession({ credentialRef, sealedProfileDir: sealed });
    expect(handle.credentialRef).toBe(credentialRef);
    expect(handle.podId).toBe("pod-test");
    expect(launcher.launches).toHaveLength(1);

    const podDir = launcher.launches[0]!;
    expect(podDir).toStartWith(podRoot);
    expect(podDir).not.toBe(sealed);
    expect(await readFile(join(podDir, "Default", "Cookies"), "utf8")).toBe("sealed-cookie-bytes");

    await host.release(handle.sessionId);
  });

  test("release re-seals the pod profile back into custody and deletes the pod dir", async () => {
    const launcher = fakeLauncher();
    const host = createBrowserHostService({ launcher, podRoot });
    const handle = await host.mountSession({ credentialRef: newUlid(), sealedProfileDir: sealed });
    const podDir = launcher.launches[0]!;

    // The browsing session updated its cookie jar inside the pod.
    await writeFile(join(podDir, "Default", "Cookies"), "refreshed-cookie-bytes");
    await host.release(handle.sessionId);

    expect(await readFile(join(sealed, "Default", "Cookies"), "utf8")).toBe(
      "refreshed-cookie-bytes",
    );
    expect(launcher.closed).toBe(1);
    expect(await readdir(podRoot)).toEqual([]);
  });

  test("a failed launch cleans up the pod dir instead of leaking unsealed cookies", async () => {
    const launcher: ChromeLauncher = {
      launch: () => Promise.reject(new Error("chrome refused to start")),
    };
    const host = createBrowserHostService({ launcher, podRoot });
    await expect(
      host.mountSession({ credentialRef: newUlid(), sealedProfileDir: sealed }),
    ).rejects.toThrow(/chrome refused to start/);
    expect(await readdir(podRoot)).toEqual([]);
  });

  test("attach returns a brokered URL — never the pod's raw CDP endpoint", async () => {
    const launcher = fakeLauncher("ws://127.0.0.1:45678/devtools/browser/raw-endpoint");
    const host = createBrowserHostService({ launcher, podRoot });
    const handle = await host.mountSession({ credentialRef: newUlid(), sealedProfileDir: sealed });

    const attachment = await host.attach(handle.sessionId);
    expect(attachment.sessionId).toBe(handle.sessionId);
    expect(attachment.wsUrl).toContain(`/cdp/${handle.sessionId}?token=`);
    expect(attachment.wsUrl).not.toContain("45678");
    expect(attachment.wsUrl).not.toContain("raw-endpoint");

    const second = await host.attach(handle.sessionId);
    expect(second.wsUrl).not.toBe(attachment.wsUrl); // fresh single-use token

    await host.release(handle.sessionId);
  });

  test("mount/attach/release are observable for the spine", async () => {
    const events: BrowserHostEvent[] = [];
    const host = createBrowserHostService({
      launcher: fakeLauncher(),
      podRoot,
      onEvent: (e) => events.push(e),
    });
    const handle = await host.mountSession({ credentialRef: newUlid(), sealedProfileDir: sealed });
    await host.attach(handle.sessionId);
    await host.release(handle.sessionId);
    expect(events.map((e) => e.kind)).toEqual(["mounted", "attached", "released"]);
    // No profile material rides an event.
    expect(JSON.stringify(events)).not.toContain("sealed-cookie-bytes");
    expect(JSON.stringify(events)).not.toContain(sealed);
  });

  test("unknown sessions fail loudly", async () => {
    const host = createBrowserHostService({ launcher: fakeLauncher(), podRoot });
    await expect(host.attach(newUlid())).rejects.toThrow(UnknownSessionError);
    await expect(host.release(newUlid())).rejects.toThrow(UnknownSessionError);
  });

  test("policy() returns the shipped default unless one is configured", () => {
    const host = createBrowserHostService({ launcher: fakeLauncher(), podRoot });
    expect(host.policy()).toEqual(defaultHumanizationPolicy);

    const strict = { ...defaultHumanizationPolicy, maxActionsPerHour: 5 };
    const strictHost = createBrowserHostService({
      launcher: fakeLauncher(),
      podRoot,
      policy: strict,
    });
    expect(strictHost.policy().maxActionsPerHour).toBe(5);
  });
});
