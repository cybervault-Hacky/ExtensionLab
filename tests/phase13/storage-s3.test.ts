import { describe, expect, it } from "vitest";
import { S3StorageProvider, isValidContentType, type S3Gateway } from "@/lib/storage/s3";
import { StorageError } from "@/lib/storage/types";

/**
 * §27/§28/§30: the S3-compatible production storage provider, exercised
 * against an in-memory gateway double — the exact code path the AWS SDK
 * adapter drives in production.
 */
class FakeS3Gateway implements S3Gateway {
  objects = new Map<string, { body: Uint8Array; contentType: string }>();
  failMode: "none" | "put" | "get" | "headBucket" = "none";
  listedPrefixes: string[] = [];

  async putObject(input: { bucket: string; key: string; body: Uint8Array; contentType?: string }): Promise<void> {
    if (this.failMode === "put") throw new Error("connection reset");
    this.objects.set(`${input.bucket}/${input.key}`, {
      body: input.body,
      contentType: input.contentType ?? "application/octet-stream",
    });
  }

  async getObject(input: { bucket: string; key: string }): Promise<Uint8Array> {
    if (this.failMode === "get") throw new Error("connection reset");
    const found = this.objects.get(`${input.bucket}/${input.key}`);
    if (!found) throw new Error("NotFound");
    return found.body;
  }

  async deleteObject(input: { bucket: string; key: string }): Promise<void> {
    this.objects.delete(`${input.bucket}/${input.key}`);
  }

  async headObject(input: { bucket: string; key: string }): Promise<{ contentLength: number; lastModified: number } | null> {
    const found = this.objects.get(`${input.bucket}/${input.key}`);
    return found ? { contentLength: found.body.byteLength, lastModified: 123 } : null;
  }

  async listObjects(input: { bucket: string; prefix: string }): Promise<string[]> {
    this.listedPrefixes.push(input.prefix);
    return [...this.objects.keys()]
      .filter((full) => full.startsWith(`${input.bucket}/${input.prefix}`))
      .map((full) => full.slice(input.bucket.length + 1));
  }

  async headBucket(): Promise<boolean> {
    return this.failMode !== "headBucket";
  }
}

function provider(gateway = new FakeS3Gateway()) {
  return {
    gateway,
    storage: new S3StorageProvider(gateway, { bucket: "extensionlab-private", prefix: "prod" }),
  };
}

describe("Phase 13 §27: S3 object storage (metadata in DB, bytes in storage)", () => {
  it("puts and gets objects under the deployment prefix", async () => {
    const { storage } = provider();
    const bytes = new Uint8Array([1, 2, 3]);
    const stat = await storage.put("artifacts/run_1/shot.png", bytes, { contentType: "image/png" });
    expect(stat.size).toBe(3);
    expect(await storage.get("artifacts/run_1/shot.png")).toEqual(bytes);
  });

  it("validates content types against a bounded allowlist (§28)", async () => {
    const { storage } = provider();
    await expect(
      storage.put("bad/type.bin", new Uint8Array([1]), { contentType: "application/x-sh" }),
    ).rejects.toBeInstanceOf(StorageError);
    expect(isValidContentType("image/png")).toBe(true);
    expect(isValidContentType("application/zip")).toBe(true);
    expect(isValidContentType("text/html")).toBe(false);
  });

  it("lists under a prefix and strips the deployment prefix", async () => {
    const { storage, gateway } = provider();
    await storage.put("artifacts/a.png", new Uint8Array([1]), { contentType: "image/png" });
    await storage.put("artifacts/b.png", new Uint8Array([2]), { contentType: "image/png" });
    await storage.put("packages/c.zip", new Uint8Array([3]), { contentType: "application/zip" });
    const keys = await storage.list("artifacts");
    expect(keys.sort()).toEqual(["artifacts/a.png", "artifacts/b.png"]);
    expect(gateway.listedPrefixes[0]).toBe("prod/artifacts");
  });

  it("exists/stat/delete behave idempotently", async () => {
    const { storage } = provider();
    await storage.put("artifacts/a.png", new Uint8Array([9]), { contentType: "image/png" });
    expect(await storage.exists("artifacts/a.png")).toBe(true);
    expect((await storage.stat("artifacts/a.png"))!.size).toBe(1);
    await storage.delete("artifacts/a.png");
    await storage.delete("artifacts/a.png"); // idempotent
    expect(await storage.exists("artifacts/a.png")).toBe(false);
    expect(await storage.stat("artifacts/a.png")).toBeNull();
  });

  it("health check verifies write+delete on the bucket (§30)", async () => {
    const ok = provider();
    expect(await ok.storage.healthCheck()).toEqual({ ok: true });
    const failing = provider();
    failing.gateway.failMode = "put";
    expect((await failing.storage.healthCheck()).ok).toBe(false);
    const unreachable = provider();
    unreachable.gateway.failMode = "headBucket";
    expect((await unreachable.storage.healthCheck()).ok).toBe(false);
  });

  it("get failures surface as not_found without leaking internals", async () => {
    const { storage } = provider();
    await expect(storage.get("artifacts/missing.bin")).rejects.toMatchObject({ kind: "not_found" });
    const broken = provider();
    broken.gateway.failMode = "get";
    await broken.storage.put("artifacts/x.png", new Uint8Array([1]), { contentType: "image/png" });
    await expect(broken.storage.get("artifacts/x.png")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("rejects invalid storage keys (path traversal never reaches the bucket)", async () => {
    const { storage } = provider();
    await expect(storage.put("../escape", new Uint8Array([1]))).rejects.toBeInstanceOf(StorageError);
    await expect(storage.list("../")).rejects.toBeInstanceOf(StorageError);
  });
});
