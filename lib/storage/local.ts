import { createReadStream as fsCreateReadStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile, rename } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { StorageError, type PutOptions, type StorageObjectStat, type StorageProvider } from "./types";
import { assertValidStorageKey } from "./validation";

/**
 * Local filesystem provider.
 *
 * Objects live under a single root directory (STORAGE_PATH). Writes are
 * atomic (temp file + rename) so a crash never leaves a partially written
 * package that could later be treated as valid. The root path is never
 * returned to callers.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly name = "local";
  private readonly root: string;
  private ready: Promise<void> | null = null;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private async ensureRoot(): Promise<void> {
    if (!this.ready) {
      this.ready = mkdir(this.root, { recursive: true, mode: 0o700 }).then(() => undefined);
    }
    await this.ready;
  }

  private pathFor(key: string): string {
    assertValidStorageKey(key);
    const full = resolve(this.root, ...key.split("/"));
    const rel = relative(this.root, full);
    if (rel.startsWith("..") || rel.split(sep).includes("..") || resolve(this.root, rel) !== full) {
      throw new StorageError("invalid_key", "Invalid storage key.");
    }
    return full;
  }

  async put(key: string, data: Uint8Array, _options?: PutOptions): Promise<StorageObjectStat> {
    void _options;
    await this.ensureRoot();
    const target = this.pathFor(key);
    const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new StorageError("io", "Storage write failed.", error);
    }
    const info = await stat(target);
    return { size: info.size, createdAt: info.mtimeMs };
  }

  async get(key: string): Promise<Uint8Array> {
    const target = this.pathFor(key);
    try {
      return new Uint8Array(await readFile(target));
    } catch (error) {
      if (isNotFound(error)) throw new StorageError("not_found", "Object not found.");
      throw new StorageError("io", "Storage read failed.", error);
    }
  }

  async delete(key: string): Promise<void> {
    const target = this.pathFor(key);
    try {
      await rm(target, { force: true });
    } catch (error) {
      throw new StorageError("io", "Storage delete failed.", error);
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async stat(key: string): Promise<StorageObjectStat | null> {
    const target = this.pathFor(key);
    try {
      const info = await stat(target);
      if (!info.isFile()) return null;
      return { size: info.size, createdAt: info.mtimeMs };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new StorageError("io", "Storage stat failed.", error);
    }
  }

  async createReadStream(key: string): Promise<Readable> {
    const target = this.pathFor(key);
    const info = await this.stat(key);
    if (!info) throw new StorageError("not_found", "Object not found.");
    return fsCreateReadStream(target);
  }

  async list(prefix: string): Promise<string[]> {
    await this.ensureRoot();
    const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "");
    if (cleanPrefix.split("/").some((part) => part === ".." || part === "")) {
      throw new StorageError("invalid_key", "Invalid prefix.");
    }
    const start = cleanPrefix ? resolve(this.root, ...cleanPrefix.split("/")) : this.root;
    const keys: string[] = [];
    await walk(start, this.root, keys);
    return keys.filter((key) => !key.endsWith(".tmp"));
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const key = `health/probe-${randomBytes(8).toString("hex")}.txt`;
    try {
      await this.put(key, new TextEncoder().encode("ok"));
      const exists = await this.exists(key);
      await this.delete(key);
      return exists ? { ok: true } : { ok: false, detail: "write_verify_failed" };
    } catch {
      return { ok: false, detail: "write_failed" };
    }
  }
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return;
    throw new StorageError("io", "Storage list failed.", error);
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, root, out);
    } else if (entry.isFile()) {
      out.push(relative(root, full).split(sep).join("/"));
    }
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "ENOENT");
}
