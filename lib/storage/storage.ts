import { getConfig } from "@/lib/config/env";
import { LocalStorageProvider } from "./local";
import type { StorageProvider } from "./types";

let instance: StorageProvider | null = null;
let instanceKey = "";

/**
 * Process-local storage provider selected from configuration. Only the local
 * provider ships today; object-storage providers implement the same interface.
 */
export function getStorage(): StorageProvider {
  const config = getConfig();
  const key = `${config.storage.provider}:${config.storage.path}`;
  if (!instance || instanceKey !== key) {
    instance = createStorageProvider(config.storage.provider, config.storage.path);
    instanceKey = key;
  }
  return instance;
}

export function createStorageProvider(provider: "local", path: string): StorageProvider {
  switch (provider) {
    case "local":
    default:
      return new LocalStorageProvider(path);
  }
}

/** Test helper: overrides the provider for the current process. */
export function setStorageForTests(provider: StorageProvider | null): void {
  instance = provider;
  instanceKey = provider ? `test:${provider.name}` : "";
}

export type { StorageProvider } from "./types";
export { StorageError } from "./types";
