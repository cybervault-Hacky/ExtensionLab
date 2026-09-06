import { getConfig } from "@/lib/config/env";
import { LocalStorageProvider } from "./local";
import { S3StorageProvider, createAwsS3Gateway } from "./s3";
import type { StorageProvider } from "./types";

let instance: StorageProvider | null = null;
let instanceKey = "";
let s3Initializing: Promise<StorageProvider> | null = null;

/**
 * Process-local storage provider selected from configuration.
 *
 * - `local`: filesystem under STORAGE_PATH (default; single-node dev/test).
 * - `s3`: private S3-compatible object storage (Phase 13 production path).
 *   The AWS SDK is an optional deployment dependency; selecting `s3` without
 *   it is a hard startup failure, never a silent fallback to local disk.
 */
export function getStorage(): StorageProvider {
  const config = getConfig();
  if (config.storage.provider === "s3") {
    // The S3 gateway is async to construct; once initialized it is reused.
    // A synchronous access before initialization is a hard error: silent
    // fallback to local storage would misplace production artifacts.
    if (instance && instanceKey === s3InstanceKey(config)) return instance;
    throw new Error("S3 storage not initialized. Await ensureStorageInitialized() during startup.");
  }
  const key = `${config.storage.provider}:${config.storage.path}`;
  if (!instance || instanceKey !== key) {
    instance = createStorageProvider(config.storage.provider, config.storage.path);
    instanceKey = key;
  }
  return instance;
}

function s3InstanceKey(config: ReturnType<typeof getConfig>): string {
  const s3 = config.storage.s3;
  return `s3:${s3.bucket}:${s3.prefix ?? ""}:${s3.endpoint ?? ""}`;
}

/** Starts up the configured provider (idempotent). Call during boot. */
export async function ensureStorageInitialized(): Promise<StorageProvider> {
  const config = getConfig();
  if (config.storage.provider !== "s3") return getStorage();
  const key = s3InstanceKey(config);
  if (instance && instanceKey === key) return instance;
  if (!s3Initializing) {
    const s3 = config.storage.s3;
    s3Initializing = createAwsS3Gateway({
      bucket: s3.bucket ?? "",
      region: s3.region ?? undefined,
      endpoint: s3.endpoint ?? undefined,
      prefix: s3.prefix ?? undefined,
      forcePathStyle: s3.forcePathStyle,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    })
      .then((gateway) => {
        instance = new S3StorageProvider(gateway, {
          bucket: s3.bucket ?? "",
          region: s3.region ?? undefined,
          endpoint: s3.endpoint ?? undefined,
          prefix: s3.prefix ?? undefined,
          forcePathStyle: s3.forcePathStyle,
        });
        instanceKey = key;
        return instance;
      })
      .finally(() => {
        s3Initializing = null;
      });
  }
  return s3Initializing;
}

export function createStorageProvider(provider: "local" | "s3", path: string): StorageProvider {
  if (provider === "s3") {
    // Sync factory cannot await the async SDK gateway; the async path above is
    // the supported route. Kept for interface parity with a clear failure.
    throw new Error("Use ensureStorageInitialized() for the s3 provider.");
  }
  return new LocalStorageProvider(path);
}

/** Test helper: overrides the provider for the current process. */
export function setStorageForTests(provider: StorageProvider | null): void {
  instance = provider;
  instanceKey = provider ? `test:${provider.name}` : "";
}
