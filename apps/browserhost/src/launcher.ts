import { existsSync } from "node:fs";

/**
 * ChromeLauncher — the process seam between the browserhost pod runtime and a
 * real headed Chrome. Production spawns the system browser with
 * `--remote-debugging-port=0 --user-data-dir=<pod dir>` and reads the DevTools
 * websocket endpoint off stderr; tests inject a fake launcher so the suite
 * never needs a browser installed.
 *
 * Headed is deliberate (ADR-003): a human completes CAPTCHAs and logins in the
 * same window the agent drives, and `--headless` is never passed.
 */

export interface ChromeLaunchHandle {
  /** Browser-level DevTools endpoint, e.g. ws://127.0.0.1:51234/devtools/browser/<id>. */
  wsEndpoint: string;
  /** The user-data-dir this browser is running against (the ephemeral pod dir). */
  userDataDir: string;
  /** Terminate the browser and wait for the process to exit. */
  close(): Promise<void>;
}

export interface ChromeLauncher {
  launch(opts: { userDataDir: string }): Promise<ChromeLaunchHandle>;
}

/** Standard install locations, in probe order (macOS first, then Linux). */
export const DEFAULT_CHROME_BINARIES: readonly string[] = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/google/chrome/chrome",
];

/** The env var that overrides binary discovery (pre-declared in server config). */
export const CHROME_BINARY_ENV = "LITHIS_CHROME_BINARY";

export interface ResolveChromeOptions {
  env?: Record<string, string | undefined>;
  /** Injectable existence probe (tests). */
  exists?: (path: string) => boolean;
  candidates?: readonly string[];
}

/**
 * Resolve the Chrome binary: LITHIS_CHROME_BINARY wins, otherwise the first
 * standard path that exists. Absent Chrome is a LOUD configuration failure —
 * a browserhost pod without a browser can do nothing, and pretending otherwise
 * would be exactly the silent placeholder this repo forbids.
 */
export function resolveChromeBinary(opts: ResolveChromeOptions = {}): string {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const candidates = opts.candidates ?? DEFAULT_CHROME_BINARIES;

  const configured = env[CHROME_BINARY_ENV];
  if (configured !== undefined && configured.length > 0) {
    if (!exists(configured)) {
      throw new Error(
        `${CHROME_BINARY_ENV} points at '${configured}', which does not exist — ` +
          `set it to the headed Chrome/Chromium executable this pod should drive`,
      );
    }
    return configured;
  }
  const found = candidates.find((c) => exists(c));
  if (found === undefined) {
    throw new Error(
      `no Chrome/Chromium binary found — looked at ${candidates.join(", ")}. ` +
        `Install a headed Chrome in the browserhost pod or set ${CHROME_BINARY_ENV} to its path.`,
    );
  }
  return found;
}

/**
 * The launch argv. Timing-only humanization means nothing here spoofs a
 * fingerprint: the sealed profile IS the identity. `--remote-debugging-port=0`
 * makes the kernel pick a free port, which Chrome then announces on stderr.
 */
export function chromeLaunchArgs(userDataDir: string): string[] {
  return [
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-features=Translate,MediaRouter",
    "--restore-last-session=false",
    "about:blank",
  ];
}

const DEVTOOLS_LINE = /DevTools listening on (ws:\/\/\S+)/;

/** Pull the DevTools websocket endpoint out of a chunk of Chrome stderr. */
export function parseDevToolsEndpoint(text: string): string | undefined {
  return DEVTOOLS_LINE.exec(text)?.[1];
}

export interface SystemChromeLauncherOptions {
  /** Override binary discovery (otherwise resolveChromeBinary at launch time). */
  binaryPath?: string;
  env?: Record<string, string | undefined>;
  /** How long to wait for the DevTools banner before giving up (default 30s). */
  startupTimeoutMs?: number;
}

/**
 * Spawn the system Chrome against `userDataDir` and resolve once it announces
 * its DevTools endpoint. Nothing about the profile is inspected here — the pod
 * directory is handed over as-is by the host, which owns unseal/reseal.
 */
export function createSystemChromeLauncher(
  opts: SystemChromeLauncherOptions = {},
): ChromeLauncher {
  const startupTimeoutMs = opts.startupTimeoutMs ?? 30_000;
  return {
    async launch({ userDataDir }): Promise<ChromeLaunchHandle> {
      const binary =
        opts.binaryPath ??
        resolveChromeBinary(opts.env !== undefined ? { env: opts.env } : {});
      const child = Bun.spawn([binary, ...chromeLaunchArgs(userDataDir)], {
        stdout: "ignore",
        stderr: "pipe",
      });

      let banner = "";
      const decoder = new TextDecoder();
      const reader = child.stderr.getReader();
      const deadline = Date.now() + startupTimeoutMs;

      let wsEndpoint: string | undefined;
      try {
        while (wsEndpoint === undefined) {
          if (Date.now() > deadline) break;
          const { value, done } = await reader.read();
          if (done) break;
          banner += decoder.decode(value, { stream: true });
          wsEndpoint = parseDevToolsEndpoint(banner);
        }
      } finally {
        reader.releaseLock();
      }

      if (wsEndpoint === undefined) {
        child.kill();
        await child.exited;
        throw new Error(
          `chrome (${binary}) did not announce a DevTools endpoint within ${startupTimeoutMs}ms — ` +
            `stderr so far: ${banner.trim().slice(-500) || "(empty)"}`,
        );
      }

      return {
        wsEndpoint,
        userDataDir,
        async close(): Promise<void> {
          child.kill();
          await child.exited;
        },
      };
    },
  };
}
