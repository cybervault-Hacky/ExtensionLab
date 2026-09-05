/**
 * Storage abstraction.
 *
 * Keys are opaque, non-guessable identifiers (`extensions/<user>/<random>.zip`,
 * `artifacts/<run>/<random>.png`). Callers never see filesystem paths or
 * provider URLs; every access goes through the provider so that the backend
 * can be swapped (local disk today, object storage later) without touching
 * business logic.
 */

import type { Readable } from "node:stream";

export interface StorageObjectStat {
  size: number;
  createdAt: number;
}

export interface PutOptions {
  contentType?: string;
}

export interface StorageProvider {
  readonly name: string;
  put(key: string, data: Uint8Array, options?: PutOptions): Promise<StorageObjectStat>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  stat(key: string): Promise<StorageObjectStat | null>;
  createReadStream(key: string): Promise<Readable>;
  /** Lists keys under a prefix. Used only by reconciliation/cleanup. */
  list(prefix: string): Promise<string[]>;
  /** Cheap health probe (write + delete of a marker). */
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

export class StorageError extends Error {
  readonly kind: "not_found" | "invalid_key" | "io";

  constructor(kind: "not_found" | "invalid_key" | "io", message: string, readonly cause?: unknown) {
    super(message);
    this.name = "StorageError";
    this.kind = kind;
  }
}
