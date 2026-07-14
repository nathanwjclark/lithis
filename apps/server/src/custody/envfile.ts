import { readFile } from "node:fs/promises";
import type { CustodyBackend } from "./index";

/**
 * The local custody backend: secret material lives in a dotenv-style file
 * (path via LITHIS_SECRETS_FILE), and credential rows point at entries with
 * custodyBackendRef "env-file:<KEY>". The file is re-read per issuance so
 * rotations take effect without a restart; values are never logged and never
 * leave this module except through the broker's in-process redemption map.
 * The GCP reference deploy swaps this for a Secret Manager backend behind the
 * same CustodyBackend seam.
 */

export const ENV_FILE_REF_PREFIX = "env-file:";

/** Parse dotenv-style text: KEY=VALUE lines, # comments, optional quotes. */
export function parseSecretsFile(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

export function createEnvFileBackend(filePath: string | undefined): CustodyBackend {
  return {
    async getSecret(custodyBackendRef: string): Promise<string> {
      if (!custodyBackendRef.startsWith(ENV_FILE_REF_PREFIX)) {
        throw new Error(
          `unsupported custody backend ref '${custodyBackendRef}' — this deployment resolves ` +
            `only '${ENV_FILE_REF_PREFIX}<KEY>' refs (Secret Manager arrives with the GCP deploy)`,
        );
      }
      const key = custodyBackendRef.slice(ENV_FILE_REF_PREFIX.length);
      if (key.length === 0) {
        throw new Error(`malformed custody backend ref '${custodyBackendRef}' — expected env-file:<KEY>`);
      }
      if (filePath === undefined || filePath.length === 0) {
        throw new Error(
          `LITHIS_SECRETS_FILE is not set — cannot resolve custody ref '${custodyBackendRef}'`,
        );
      }
      const text = await readFile(filePath, "utf8");
      const value = parseSecretsFile(text).get(key);
      if (value === undefined || value.length === 0) {
        throw new Error(`secret '${key}' not found in secrets file ${filePath}`);
      }
      return value;
    },
  };
}
