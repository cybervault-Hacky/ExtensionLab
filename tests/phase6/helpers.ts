import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "@/lib/db/client";
import { resetConfigCache } from "@/lib/config/env";
import { setStorageForTests, createStorageProvider } from "@/lib/storage/storage";
import { setEmailProviderForTests } from "@/lib/email/email-service";
import { createUser } from "@/lib/db/repositories/users";
import { setLogLevel } from "@/lib/observability/logger";

/**
 * Shared Phase 6 test harness: an isolated on-disk SQLite database (so the
 * worker's transactions behave like production) plus a throw-away storage
 * directory. Everything is removed in `teardown`.
 */
export interface Harness {
  dir: string;
  teardown(): void;
}

export function setupHarness(env: Record<string, string> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "el-p6-"));
  closeDb();
  resetConfigCache();
  process.env.APP_ENV = "test";
  process.env.EXTENSIONLAB_DB_PATH = join(dir, "db.sqlite");
  delete process.env.DATABASE_URL;
  process.env.STORAGE_PATH = join(dir, "storage");
  process.env.SANDBOX_TEMP_ROOT = join(dir, "runtime");
  process.env.WORKER_MODE = "disabled";
  process.env.EMAIL_PROVIDER = "noop";
  process.env.LOG_LEVEL = "error";
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  setLogLevel("error");
  resetConfigCache();
  setStorageForTests(createStorageProvider("local", join(dir, "storage")));
  setEmailProviderForTests(null);
  return {
    dir,
    teardown() {
      closeDb();
      setStorageForTests(null);
      setEmailProviderForTests(null);
      resetConfigCache();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function makeUser(email = `user-${Math.random().toString(16).slice(2)}@example.com`) {
  return createUser({ email, passwordHash: "x".repeat(60), name: "Test" });
}
