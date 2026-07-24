import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The custody-side profile store: where SEALED browser profiles live.
 *
 * This is the browser-session sibling of CustodyBackend. A `browser_session`
 * Credential's custodyBackendRef is `browser-profile:<key>`, and this store
 * resolves that key to a directory holding the sealed profile — one directory
 * per credential under LITHIS_BROWSER_PROFILE_DIR (default ~/.lithis/profiles).
 * Nothing here ever reads profile BYTES: it resolves a location, and only a
 * browserhost pod ever opens it (ADR-003).
 *
 * P15-gcp swaps this for an object-storage-backed store (sealed profile
 * archives in a bucket, unsealed into the pod on mount) behind the same
 * BrowserProfileStore seam — the local backend is the whole implementation
 * today, not a placeholder for one.
 */

export const BROWSER_PROFILE_REF_PREFIX = "browser-profile:";

export const DEFAULT_BROWSER_PROFILE_DIR = join(homedir(), ".lithis", "profiles");

export interface BrowserProfileStore {
  /** Resolve a custodyBackendRef to the directory holding the sealed profile. */
  resolve(custodyBackendRef: string): Promise<string>;
  /**
   * Create an empty profile directory for a key so a human can complete the
   * one-time interactive login that seeds it. Never called during a mount.
   */
  prepare(custodyBackendRef: string): Promise<string>;
}

/** Profile keys name directories — keep them boring so they cannot escape the root. */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function profileKeyFromRef(custodyBackendRef: string): string {
  if (!custodyBackendRef.startsWith(BROWSER_PROFILE_REF_PREFIX)) {
    throw new Error(
      `custody backend ref '${custodyBackendRef}' is not a browser profile — browser_session ` +
        `credentials must point at '${BROWSER_PROFILE_REF_PREFIX}<key>'`,
    );
  }
  const key = custodyBackendRef.slice(BROWSER_PROFILE_REF_PREFIX.length);
  if (!SAFE_KEY.test(key)) {
    throw new Error(
      `malformed browser profile ref '${custodyBackendRef}' — the key must match ${SAFE_KEY.source}`,
    );
  }
  return key;
}

export function createLocalBrowserProfileStore(rootDir?: string): BrowserProfileStore {
  const root = resolve(
    rootDir !== undefined && rootDir.length > 0 ? rootDir : DEFAULT_BROWSER_PROFILE_DIR,
  );

  function dirFor(custodyBackendRef: string): string {
    const dir = join(root, profileKeyFromRef(custodyBackendRef));
    // Belt and braces on top of SAFE_KEY: never hand out a path outside root.
    if (!isAbsolute(dir) || !dir.startsWith(root)) {
      throw new Error(`browser profile ref '${custodyBackendRef}' resolved outside ${root}`);
    }
    return dir;
  }

  return {
    async resolve(custodyBackendRef: string): Promise<string> {
      const dir = dirFor(custodyBackendRef);
      try {
        await access(dir);
      } catch {
        throw new Error(
          `no sealed browser profile at ${dir} — seed it by completing the interactive login once ` +
            `in a browserhost pod (lithis never fabricates a session)`,
        );
      }
      return dir;
    },

    async prepare(custodyBackendRef: string): Promise<string> {
      const dir = dirFor(custodyBackendRef);
      await mkdir(dir, { recursive: true });
      return dir;
    },
  };
}
