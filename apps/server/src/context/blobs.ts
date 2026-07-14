import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Blob storage seam. Two drivers behind one interface:
 *
 *  - local-directory driver (default): bytes under `LITHIS_BLOB_DIR`
 *    (default `var/blobs` beneath the server cwd), refs are `file://<abs path>`.
 *    This is what local dev, tests, and CI use — no minio/docker required.
 *  - S3 driver via Bun's built-in S3 client, used when `OBJECT_STORE_URL`
 *    is set; refs are `s3://<bucket>/<key>`. Credentials come from the URL
 *    userinfo when present, otherwise Bun's standard S3 env vars
 *    (S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY / ...).
 *
 * storageRef strings are self-describing by scheme; each driver refuses refs
 * it did not mint, so a mis-wired driver fails loudly instead of returning
 * wrong bytes.
 */

export interface BlobStorage {
  /** Store bytes for (tenant, sha256); returns the storageRef persisted on the blob row. */
  put(tenantId: string, sha256: string, bytes: Uint8Array): Promise<string>;
  /** Fetch the bytes for a storageRef previously returned by put(). */
  get(storageRef: string): Promise<Uint8Array>;
}

export const DEFAULT_BLOB_DIR = "var/blobs";
export const DEFAULT_BLOB_BUCKET = "lithis-blobs";

export function createLocalBlobStorage(rootDir: string = DEFAULT_BLOB_DIR): BlobStorage {
  const root = resolve(rootDir);
  return {
    async put(tenantId, sha256, bytes) {
      // Two-char fan-out keeps directories small at scale; path is fully
      // derived from (tenant, hash) so re-puts of identical bytes are no-ops.
      const path = join(root, tenantId, sha256.slice(0, 2), sha256);
      mkdirSync(dirname(path), { recursive: true });
      await Bun.write(path, bytes);
      return `file://${path}`;
    },
    async get(storageRef) {
      if (!storageRef.startsWith("file://")) {
        throw new Error(
          `local blob storage cannot resolve ref '${storageRef}' — expected a file:// ref`,
        );
      }
      const path = storageRef.slice("file://".length);
      const file = Bun.file(path);
      if (!(await file.exists())) {
        throw new Error(`blob bytes missing on disk for ref '${storageRef}'`);
      }
      return new Uint8Array(await file.arrayBuffer());
    },
  };
}

export function createS3BlobStorage(objectStoreUrl: string, bucket: string): BlobStorage {
  const url = new URL(objectStoreUrl);
  const client = new Bun.S3Client({
    endpoint: `${url.protocol}//${url.host}`,
    bucket,
    // URL userinfo (minio-style) wins; otherwise Bun falls back to its
    // standard S3 env vars automatically.
    ...(url.username !== "" ? { accessKeyId: decodeURIComponent(url.username) } : {}),
    ...(url.password !== "" ? { secretAccessKey: decodeURIComponent(url.password) } : {}),
  });
  const refPrefix = `s3://${bucket}/`;
  return {
    async put(tenantId, sha256, bytes) {
      const key = `blobs/${tenantId}/${sha256.slice(0, 2)}/${sha256}`;
      await client.write(key, bytes);
      return `${refPrefix}${key}`;
    },
    async get(storageRef) {
      if (!storageRef.startsWith(refPrefix)) {
        throw new Error(
          `s3 blob storage cannot resolve ref '${storageRef}' — expected prefix '${refPrefix}'`,
        );
      }
      const key = storageRef.slice(refPrefix.length);
      return new Uint8Array(await client.file(key).arrayBuffer());
    },
  };
}
