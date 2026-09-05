import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { LocalStorageProvider } from "@/lib/storage/local";
import { StorageError } from "@/lib/storage/types";
import { artifactStorageKey, isValidStorageKey, packageStorageKey, sha256Hex } from "@/lib/storage/validation";
import { setupHarness, makeUser, type Harness } from "./helpers";
import { deleteOwnedPackage, readOwnedPackageBytes, reconcilePackages, storeExtensionPackage } from "@/lib/packages/service";
import { getPackageById, listPackagesForUser, toPackage } from "@/lib/db/repositories/packages";
import { getStorage } from "@/lib/storage/storage";
import { AppError } from "@/lib/observability/errors";

async function makeZip(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return zip.generateAsync({ type: "uint8array" });
}

const validManifest = JSON.stringify({
  manifest_version: 3,
  name: "Storage Fixture",
  version: "2.3.4",
  background: { service_worker: "background.js" },
});

describe("LocalStorageProvider", () => {
  let dir: string;
  let provider: LocalStorageProvider;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "el-storage-"));
    provider = new LocalStorageProvider(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips bytes and reports stat/exists/delete", async () => {
    const key = packageStorageKey("usr_test");
    const data = new TextEncoder().encode("hello world");
    const stat = await provider.put(key, data);
    expect(stat.size).toBe(data.byteLength);
    expect(await provider.exists(key)).toBe(true);
    expect(Buffer.from(await provider.get(key)).toString()).toBe("hello world");
    expect((await provider.stat(key))?.size).toBe(data.byteLength);
    const chunks: Buffer[] = [];
    for await (const chunk of await provider.createReadStream(key)) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("hello world");
    await provider.delete(key);
    expect(await provider.exists(key)).toBe(false);
    expect(await provider.stat(key)).toBeNull();
    await expect(provider.get(key)).rejects.toBeInstanceOf(StorageError);
  });

  it("rejects path traversal and malformed keys", async () => {
    for (const bad of ["../etc/passwd", "extensions/../../x.zip", "/abs/path.zip", "extensions/a/b\\c.zip", "", "extensions/a/..", "extensions/a/%2e%2e/x"]) {
      expect(isValidStorageKey(bad)).toBe(false);
      await expect(provider.put(bad, new Uint8Array([1]))).rejects.toBeInstanceOf(StorageError);
      await expect(provider.get(bad)).rejects.toBeInstanceOf(StorageError);
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it("generates non-guessable, namespaced keys", () => {
    const a = packageStorageKey("usr_1");
    const b = packageStorageKey("usr_1");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^extensions\/usr_1\/[a-f0-9]{32}\.zip$/);
    expect(artifactStorageKey("run_9", "png")).toMatch(/^artifacts\/run_9\/[a-f0-9]{32}\.png$/);
    expect(isValidStorageKey(a)).toBe(true);
  });

  it("lists keys by prefix and passes its health check", async () => {
    await provider.put("extensions/u/a.zip", new Uint8Array([1]));
    await provider.put("extensions/u/b.zip", new Uint8Array([2]));
    await provider.put("artifacts/r/c.png", new Uint8Array([3]));
    expect((await provider.list("extensions/")).sort()).toEqual(["extensions/u/a.zip", "extensions/u/b.zip"]);
    expect((await provider.healthCheck()).ok).toBe(true);
  });
});

describe("extension package service", () => {
  let harness: Harness;
  beforeEach(() => {
    harness = setupHarness();
  });
  afterEach(() => harness.teardown());

  it("validates, stores, verifies and persists a package without exposing paths", async () => {
    const user = makeUser();
    const bytes = await makeZip({ "manifest.json": validManifest, "background.js": "console.log(1)" });
    const stored = await storeExtensionPackage({ userId: user.id, bytes, fileName: "ext.zip" });

    expect(stored.reused).toBe(false);
    expect(stored.package.id).toMatch(/^pkg_/);
    expect(stored.package.sha256).toBe(sha256Hex(bytes));
    expect(stored.package.size).toBe(bytes.byteLength);
    expect(stored.package.version).toBe("2.3.4");
    // Public projection never contains the storage key or a filesystem path.
    const publicJson = JSON.stringify(stored.package);
    expect(publicJson).not.toContain("storage");
    expect(publicJson).not.toContain(harness.dir);

    const row = getPackageById(stored.package.id)!;
    expect(row.storage_key).toMatch(/^extensions\//);
    expect(await getStorage().exists(row.storage_key)).toBe(true);

    const read = await readOwnedPackageBytes(user.id, stored.package.id);
    expect(sha256Hex(read.bytes)).toBe(stored.package.sha256);
  });

  it("reuses an identical upload for the same user (content addressed)", async () => {
    const user = makeUser();
    const bytes = await makeZip({ "manifest.json": validManifest, "background.js": "1" });
    const first = await storeExtensionPackage({ userId: user.id, bytes, fileName: "a.zip" });
    const second = await storeExtensionPackage({ userId: user.id, bytes, fileName: "b.zip" });
    expect(second.reused).toBe(true);
    expect(second.package.id).toBe(first.package.id);
    expect(listPackagesForUser(user.id)).toHaveLength(1);
  });

  it("rejects invalid archives before touching storage", async () => {
    const user = makeUser();
    await expect(storeExtensionPackage({ userId: user.id, bytes: new Uint8Array([1, 2, 3]), fileName: "x.zip" })).rejects.toMatchObject({ code: "INVALID_EXTENSION" });
    const noManifest = await makeZip({ "index.js": "1" });
    await expect(storeExtensionPackage({ userId: user.id, bytes: noManifest, fileName: "x.zip" })).rejects.toBeInstanceOf(AppError);
    expect(await getStorage().list("extensions/")).toEqual([]);
    expect(listPackagesForUser(user.id)).toHaveLength(0);
  });

  it("enforces ownership on reads and deletes blobs with the record", async () => {
    const owner = makeUser();
    const other = makeUser();
    const bytes = await makeZip({ "manifest.json": validManifest, "background.js": "1" });
    const stored = await storeExtensionPackage({ userId: owner.id, bytes, fileName: "ext.zip" });
    await expect(readOwnedPackageBytes(other.id, stored.package.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await deleteOwnedPackage(other.id, stored.package.id)).toBe(false);

    const key = getPackageById(stored.package.id)!.storage_key;
    expect(await deleteOwnedPackage(owner.id, stored.package.id)).toBe(true);
    expect(getPackageById(stored.package.id)).toBeNull();
    expect(await getStorage().exists(key)).toBe(false);
  });

  it("reconciles missing blobs and respects the grace period for fresh orphans", async () => {
    const user = makeUser();
    const bytes = await makeZip({ "manifest.json": validManifest, "background.js": "1" });
    const stored = await storeExtensionPackage({ userId: user.id, bytes, fileName: "ext.zip" });
    const key = getPackageById(stored.package.id)!.storage_key;
    await getStorage().delete(key);
    const orphanKey = "extensions/usr_ghost/deadbeefdeadbeefdeadbeefdeadbeef.zip";
    await getStorage().put(orphanKey, new Uint8Array([1]));

    const report = await reconcilePackages();
    expect(report.missingBlobs).toBe(1);
    // Fresh blobs may belong to an in-flight upload; they are kept for now.
    expect(report.orphanedBlobs).toBe(0);
    expect(await getStorage().exists(orphanKey)).toBe(true);
    expect(getPackageById(stored.package.id)?.status).toBe("deleted");
    expect(existsSync(join(harness.dir, "storage"))).toBe(true);
    expect(toPackage(getPackageById(stored.package.id)!).id).toBe(stored.package.id);
    // A second pass is idempotent.
    expect((await reconcilePackages()).missingBlobs).toBe(0);
  });
});
