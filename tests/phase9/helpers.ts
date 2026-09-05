import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "@/lib/db/client";
import { resetConfigCache } from "@/lib/config/env";
import { setStorageForTests, createStorageProvider } from "@/lib/storage/storage";
import { setEmailProviderForTests } from "@/lib/email/email-service";
import { createUser } from "@/lib/db/repositories/users";
import { setLogLevel } from "@/lib/observability/logger";
import { setBrowserHealthForTests } from "@/lib/browsers/availability";
import type { BrowserHealthMap } from "@/lib/browsers/availability";
import type { PlanId } from "@/lib/billing/types";
import { upsertBillingCustomer, upsertSubscription } from "@/lib/db/repositories/billing";

/** Shared Phase 9 harness: isolated DB + storage, with browser health faked. */
export interface Harness {
  dir: string;
  teardown(): void;
}

export const ALL_BROWSERS_HEALTHY: BrowserHealthMap = {
  chromium: { browserId: "chromium", available: true },
  edge: { browserId: "edge", available: true },
  firefox: { browserId: "firefox", available: true },
};

export function setupHarness(env: Record<string, string> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "el-p9-"));
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
      setBrowserHealthForTests(null);
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

/** Activates a paid plan locally (verified provider state, like a webhook would). */
export function activatePlan(userId: string, planId: Exclude<PlanId, "free">, provider = "fake"): void {
  const now = Date.now();
  upsertBillingCustomer({ userId, provider, providerCustomerId: `cust_${userId}` });
  upsertSubscription({
    userId,
    provider,
    providerCustomerId: `cust_${userId}`,
    providerSubscriptionId: `sub_${userId}_${planId}`,
    providerPriceId: `price_${planId}_test`,
    planId,
    status: "active",
    currentPeriodStart: now - 1000,
    currentPeriodEnd: now + 30 * 24 * 3600 * 1000,
    cancelAtPeriodEnd: false,
    cancelAt: null,
    canceledAt: null,
    trialEnd: null,
    endedAt: null,
    eventAt: now,
  });
}
