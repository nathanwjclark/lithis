import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalBlobStorage } from "../src/context/blobs";

describe("local blob storage driver", () => {
  const root = mkdtempSync(join(tmpdir(), "lithis-blobs-"));
  const storage = createLocalBlobStorage(root);
  const tenantId = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
  const sha = "a".repeat(64);

  test("put → get round-trips bytes and mints a file:// ref", async () => {
    const bytes = new TextEncoder().encode("hello blob");
    const ref = await storage.put(tenantId, sha, bytes);
    expect(ref.startsWith("file://")).toBe(true);
    expect(ref).toContain(tenantId);
    expect(ref).toContain(sha);
    expect(new TextDecoder().decode(await storage.get(ref))).toBe("hello blob");
  });

  test("re-put of the same (tenant, hash) is an idempotent overwrite", async () => {
    const bytes = new TextEncoder().encode("hello blob");
    const ref1 = await storage.put(tenantId, sha, bytes);
    const ref2 = await storage.put(tenantId, sha, bytes);
    expect(ref1).toBe(ref2);
  });

  test("refuses refs from another driver's scheme", () => {
    expect(storage.get("s3://bucket/key")).rejects.toThrow(/expected a file:\/\/ ref/);
  });

  test("missing bytes fail loudly", () => {
    expect(storage.get(`file://${join(root, "nope")}`)).rejects.toThrow(/missing on disk/);
  });
});
