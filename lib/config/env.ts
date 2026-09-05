/**
 * Validated application configuration.
 *
 * Every environment variable used by the web process and the worker is read
 * through this module. Values are validated once, defaults are explicit, and
 * production start-up fails fast when mandatory secrets are missing. Secrets
 * are never included in the object returned by `describeConfig()` (used by
 * readiness/ops output).
 */

import { join } from "node:path";
import { MAX_EXTENSION_SIZE } from "@/lib/extension/limits";

export type AppEnv = "development" | "test" | "production";
export type StorageProviderName = "local";
export type EmailProviderName = "console" | "file" | "http" | "noop";
type BillingProviderName = "stripe" | "fake" | "disabled";
export type WorkerMode = "embedded" | "external" | "disabled";

export interface AppConfig {
  appEnv: AppEnv;
  appUrl: string;
  databasePath: string;
  sessionSecret: string | null;
  storage: {
    provider: StorageProviderName;
    path: string;
  };
  sandbox: {
    image: string;
    maxConcurrency: number;
    userConcurrency: number;
    timeoutMs: number;
    disabled: boolean;
  };
  jobs: {
    maxRetries: number;
    workerMode: WorkerMode;
    workerId: string;
    workerConcurrency: number;
    pollIntervalMs: number;
    leaseMs: number;
    maxQueuedPerUser: number;
    maxQueueLength: number;
    jobTimeoutMs: number;
    shutdownGraceMs: number;
    cleanupIntervalMs: number;
  };
  email: {
    provider: EmailProviderName;
    from: string;
    fileDir: string | null;
    httpUrl: string | null;
    httpToken: string | null;
  };
  resetDevDir: string | null;
  logLevel: "debug" | "info" | "warn" | "error";
  maxExtensionSize: number;
  /** Phase 7 billing (see docs/BILLING.md). Secrets are never exposed by describeConfig(). */
  billing: {
    provider: BillingProviderName;
    /** Provider API secret (Stripe restricted/secret key). */
    secretKey: string | null;
    /** Webhook signing secret. */
    webhookSecret: string | null;
    currency: string;
    /** Provider price ids per paid plan; a paid plan is purchasable only when set. */
    priceIds: { pro: string | null; business: string | null };
    /** Display amounts in minor units per paid plan (informational; the provider price is authoritative). */
    amounts: { pro: number | null; business: number | null };
    /** Development/test only: the fake provider's shared webhook secret. */
    fakeWebhookSecret: string | null;
    /** How a paid subscription is handled when the owner deletes their account. */
    deletionPolicy: "cancel_immediately" | "cancel_at_period_end";
    /** Days a past_due subscription keeps paid entitlements while the provider retries payment. */
    pastDueGraceDays: number;
  };
  /** Requests per minute per client for the sensitive endpoints. */
  rateLimits: {
    login: number;
    signup: number;
    forgotPassword: number;
    resetPassword: number;
    upload: number;
    analysis: number;
    testCreate: number;
    sandboxCreate: number;
    shareCreate: number;
    publicReport: number;
    reportCreate: number;
    billingRead: number;
    billingCheckout: number;
    billingPortal: number;
    billingChange: number;
    billingWebhook: number;
  };
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

let cached: AppConfig | null = null;

function str(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function num(name: string, fallback: number, problems: string[], opts: { min?: number; max?: number } = {}): number {
  const raw = str(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    problems.push(`${name} must be a number`);
    return fallback;
  }
  if (opts.min !== undefined && parsed < opts.min) {
    problems.push(`${name} must be >= ${opts.min}`);
    return fallback;
  }
  if (opts.max !== undefined && parsed > opts.max) {
    problems.push(`${name} must be <= ${opts.max}`);
    return fallback;
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = str(name);
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T, problems: string[]): T {
  const raw = str(name);
  if (raw === undefined) return fallback;
  const lowered = raw.toLowerCase() as T;
  if (!allowed.includes(lowered)) {
    problems.push(`${name} must be one of ${allowed.join(", ")}`);
    return fallback;
  }
  return lowered;
}

function resolveAppEnv(): AppEnv {
  const explicit = str("APP_ENV")?.toLowerCase();
  if (explicit === "production" || explicit === "development" || explicit === "test") return explicit;
  if (process.env.VITEST || process.env.NODE_ENV === "test") return "test";
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

function resolveDatabasePath(problems: string[]): string {
  // DATABASE_URL takes precedence; legacy Phase 5 variables remain supported.
  const url = str("DATABASE_URL");
  if (url) {
    if (url === ":memory:" || url === "sqlite::memory:") return ":memory:";
    if (url.startsWith("sqlite:")) {
      const path = url.replace(/^sqlite:(\/\/)?/, "");
      if (!path) problems.push("DATABASE_URL sqlite path is empty");
      return path;
    }
    if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
      problems.push(
        "DATABASE_URL points to PostgreSQL but this build only ships the SQLite driver (see docs/DEPLOYMENT.md)",
      );
      return url;
    }
    return url;
  }
  return (
    str("EXTENSIONLAB_DB_PATH") ??
    str("DATABASE_PATH") ??
    join(process.cwd(), "data", "extensionlab.sqlite")
  );
}

/**
 * Builds and validates the configuration from `process.env`.
 * Throws `ConfigError` in production when mandatory values are missing.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const previous = process.env;
  if (env !== process.env) process.env = env;
  try {
    return buildConfig();
  } finally {
    if (env !== previous) process.env = previous;
  }
}

function buildConfig(): AppConfig {
  const problems: string[] = [];
  const appEnv = resolveAppEnv();
  const isProduction = appEnv === "production";

  const appUrl = str("APP_URL") ?? "http://localhost:3000";
  try {
    const parsed = new URL(appUrl);
    if (isProduction && parsed.protocol !== "https:") {
      problems.push("APP_URL must use https in production");
    }
  } catch {
    problems.push("APP_URL must be an absolute URL");
  }

  const sessionSecret = str("SESSION_SECRET") ?? null;
  if (isProduction && (!sessionSecret || sessionSecret.length < 32)) {
    problems.push("SESSION_SECRET must be set (at least 32 characters) in production");
  }

  const storageProvider = oneOf("STORAGE_PROVIDER", ["local"] as const, "local", problems);
  const storagePath = str("STORAGE_PATH") ?? join(process.cwd(), "data", "storage");

  const sandboxMaxConcurrency = num(
    "SANDBOX_MAX_CONCURRENCY",
    num("SANDBOX_MAX_CONCURRENT", 4, problems, { min: 1 }),
    problems,
    { min: 1, max: 64 },
  );
  const sandboxUserConcurrency = num("SANDBOX_USER_CONCURRENCY", 1, problems, { min: 1, max: 16 });
  const sandboxTimeoutSeconds = num(
    "SANDBOX_TIMEOUT",
    num("SANDBOX_MAX_RUNTIME", 120, problems, { min: 10 }),
    problems,
    { min: 10, max: 3600 },
  );

  const workerMode = oneOf(
    "WORKER_MODE",
    ["embedded", "external", "disabled"] as const,
    isProduction ? "external" : "embedded",
    problems,
  );

  const emailProvider = oneOf(
    "EMAIL_PROVIDER",
    ["console", "file", "http", "noop"] as const,
    isProduction ? "noop" : "console",
    problems,
  );
  const emailHttpUrl = str("EMAIL_HTTP_URL") ?? null;
  const emailHttpToken = str("EMAIL_HTTP_TOKEN") ?? null;
  const emailFileDir = str("EMAIL_FILE_DIR") ?? null;
  if (emailProvider === "http") {
    if (!emailHttpUrl) problems.push("EMAIL_HTTP_URL is required when EMAIL_PROVIDER=http");
    else if (isProduction && !emailHttpUrl.startsWith("https://")) problems.push("EMAIL_HTTP_URL must use https");
    if (!emailHttpToken) problems.push("EMAIL_HTTP_TOKEN is required when EMAIL_PROVIDER=http");
  }
  if (emailProvider === "file" && !emailFileDir) {
    problems.push("EMAIL_FILE_DIR is required when EMAIL_PROVIDER=file");
  }
  if (isProduction && (emailProvider === "console" || emailProvider === "file")) {
    problems.push("EMAIL_PROVIDER=console/file is not allowed in production");
  }
  if (isProduction && !str("EMAIL_PROVIDER")) {
    problems.push("EMAIL_PROVIDER must be set explicitly in production (http or noop)");
  }

  const resetDevDir = str("EXTENSIONLAB_RESET_DEV_DIR") ?? null;
  if (isProduction && resetDevDir) {
    problems.push("EXTENSIONLAB_RESET_DEV_DIR must not be set in production");
  }

  const logLevel = oneOf("LOG_LEVEL", ["debug", "info", "warn", "error"] as const, appEnv === "test" ? "warn" : "info", problems);

  // Billing. The fake provider is for development/tests only and must be chosen
  // explicitly; production never falls back to it.
  const billingProvider = oneOf(
    "BILLING_PROVIDER",
    ["stripe", "fake", "disabled"] as const,
    isProduction ? "disabled" : "fake",
    problems,
  );
  const billingSecretKey = str("BILLING_SECRET_KEY") ?? null;
  const billingWebhookSecret = str("BILLING_WEBHOOK_SECRET") ?? null;
  const billingCurrency = (str("BILLING_CURRENCY") ?? "inr").toLowerCase();
  if (!/^[a-z]{3}$/.test(billingCurrency)) problems.push("BILLING_CURRENCY must be a 3-letter ISO 4217 code");
  const proPriceId = str("BILLING_PRO_PRICE_ID") ?? null;
  const businessPriceId = str("BILLING_BUSINESS_PRICE_ID") ?? null;
  const proAmount = str("BILLING_PRO_AMOUNT") !== undefined ? num("BILLING_PRO_AMOUNT", 0, problems, { min: 0 }) : null;
  const businessAmount =
    str("BILLING_BUSINESS_AMOUNT") !== undefined ? num("BILLING_BUSINESS_AMOUNT", 0, problems, { min: 0 }) : null;
  const fakeWebhookSecret = str("BILLING_FAKE_WEBHOOK_SECRET") ?? null;
  if (billingProvider === "stripe") {
    if (!billingSecretKey) problems.push("BILLING_SECRET_KEY is required when BILLING_PROVIDER=stripe");
    if (!billingWebhookSecret) problems.push("BILLING_WEBHOOK_SECRET is required when BILLING_PROVIDER=stripe");
    if (!proPriceId && !businessPriceId) {
      problems.push("At least one of BILLING_PRO_PRICE_ID / BILLING_BUSINESS_PRICE_ID is required when BILLING_PROVIDER=stripe");
    }
    if (isProduction && billingSecretKey && !/^(sk|rk)_live_/.test(billingSecretKey)) {
      problems.push("BILLING_SECRET_KEY must be a live Stripe key in production");
    }
  }
  if (billingProvider === "fake" && isProduction) {
    problems.push("BILLING_PROVIDER=fake is not allowed in production");
  }
  if (isProduction && fakeWebhookSecret) {
    problems.push("BILLING_FAKE_WEBHOOK_SECRET must not be set in production");
  }
  const deletionPolicy = oneOf(
    "BILLING_DELETION_POLICY",
    ["cancel_immediately", "cancel_at_period_end"] as const,
    "cancel_immediately",
    problems,
  );

  const config: AppConfig = {
    appEnv,
    appUrl: appUrl.replace(/\/$/, ""),
    databasePath: resolveDatabasePath(problems),
    sessionSecret,
    storage: { provider: storageProvider, path: storagePath },
    sandbox: {
      image: str("SANDBOX_IMAGE") ?? "extensionlab-sandbox:local",
      maxConcurrency: sandboxMaxConcurrency,
      userConcurrency: sandboxUserConcurrency,
      timeoutMs: sandboxTimeoutSeconds * 1000,
      disabled: bool("SANDBOX_DISABLED", false),
    },
    jobs: {
      maxRetries: num("JOB_MAX_RETRIES", 3, problems, { min: 0, max: 10 }),
      workerMode,
      workerId: str("WORKER_ID") ?? defaultWorkerId(),
      workerConcurrency: Math.min(
        num("WORKER_CONCURRENCY", sandboxMaxConcurrency, problems, { min: 1, max: 64 }),
        sandboxMaxConcurrency,
      ),
      pollIntervalMs: num("WORKER_POLL_INTERVAL_MS", 1000, problems, { min: 50 }),
      leaseMs: num("WORKER_LEASE_MS", 15000, problems, { min: 1000 }),
      maxQueuedPerUser: num("JOB_MAX_QUEUED_PER_USER", 3, problems, { min: 1 }),
      maxQueueLength: num("JOB_MAX_QUEUE_LENGTH", 200, problems, { min: 1 }),
      jobTimeoutMs: num("JOB_TIMEOUT_MS", sandboxTimeoutSeconds * 1000 + 90_000, problems, { min: 5000 }),
      shutdownGraceMs: num("WORKER_SHUTDOWN_GRACE_MS", 20_000, problems, { min: 0 }),
      cleanupIntervalMs: num("CLEANUP_INTERVAL_MS", 15 * 60 * 1000, problems, { min: 10_000 }),
    },
    email: {
      provider: emailProvider,
      from: str("EMAIL_FROM") ?? "ExtensionLab <no-reply@localhost>",
      fileDir: emailFileDir,
      httpUrl: emailHttpUrl,
      httpToken: emailHttpToken,
    },
    resetDevDir,
    logLevel,
    maxExtensionSize: num("PLAN_MAX_EXTENSION_SIZE", MAX_EXTENSION_SIZE, problems, { min: 1024 }),
    billing: {
      provider: billingProvider,
      secretKey: billingSecretKey,
      webhookSecret: billingWebhookSecret,
      currency: billingCurrency,
      priceIds: { pro: proPriceId, business: businessPriceId },
      amounts: { pro: proAmount, business: businessAmount },
      fakeWebhookSecret,
      deletionPolicy,
      pastDueGraceDays: num("BILLING_PAST_DUE_GRACE_DAYS", 7, problems, { min: 0, max: 60 }),
    },
    rateLimits: {
      login: num("RATE_LIMIT_LOGIN_PER_MIN", 30, problems, { min: 1 }),
      signup: num("RATE_LIMIT_SIGNUP_PER_MIN", 30, problems, { min: 1 }),
      forgotPassword: num("RATE_LIMIT_FORGOT_PASSWORD_PER_MIN", 10, problems, { min: 1 }),
      resetPassword: num("RATE_LIMIT_RESET_PASSWORD_PER_MIN", 20, problems, { min: 1 }),
      upload: num("RATE_LIMIT_UPLOAD_PER_MIN", 30, problems, { min: 1 }),
      analysis: num("RATE_LIMIT_ANALYSIS_PER_MIN", 30, problems, { min: 1 }),
      testCreate: num("RATE_LIMIT_TEST_CREATE_PER_MIN", 20, problems, { min: 1 }),
      sandboxCreate: num("RATE_LIMIT_SANDBOX_CREATE_PER_MIN", 10, problems, { min: 1 }),
      shareCreate: num("RATE_LIMIT_SHARE_CREATE_PER_MIN", 20, problems, { min: 1 }),
      publicReport: num("RATE_LIMIT_PUBLIC_REPORT_PER_MIN", 60, problems, { min: 1 }),
      reportCreate: num("RATE_LIMIT_REPORT_CREATE_PER_MIN", 30, problems, { min: 1 }),
      billingRead: num("RATE_LIMIT_BILLING_READ_PER_MIN", 60, problems, { min: 1 }),
      billingCheckout: num("RATE_LIMIT_BILLING_CHECKOUT_PER_MIN", 5, problems, { min: 1 }),
      billingPortal: num("RATE_LIMIT_BILLING_PORTAL_PER_MIN", 5, problems, { min: 1 }),
      billingChange: num("RATE_LIMIT_BILLING_CHANGE_PER_MIN", 10, problems, { min: 1 }),
      // Keyed by source address; generous so provider retries are never dropped.
      billingWebhook: num("RATE_LIMIT_BILLING_WEBHOOK_PER_MIN", 600, problems, { min: 1 }),
    },
  };

  if (problems.length > 0 && isProduction) {
    throw new ConfigError(problems);
  }
  if (problems.length > 0) {
    // Development/test: surface problems once without crashing.
    process.stderr.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level: "warn", event: "config.problems", problems })}\n`,
    );
  }
  return config;
}

function defaultWorkerId(): string {
  const host = process.env.HOSTNAME || "worker";
  return `${host}-${process.pid}`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
}

/** Memoized configuration for the current process. */
export function getConfig(): AppConfig {
  if (!cached) cached = buildConfig();
  return cached;
}

/** Test helper: clears the memoized configuration. */
export function resetConfigCache(): void {
  cached = null;
}

/** Safe, secret-free description of the active configuration. */
export function describeConfig(config: AppConfig = getConfig()): Record<string, unknown> {
  return {
    appEnv: config.appEnv,
    storageProvider: config.storage.provider,
    sandbox: {
      maxConcurrency: config.sandbox.maxConcurrency,
      userConcurrency: config.sandbox.userConcurrency,
      timeoutSeconds: Math.round(config.sandbox.timeoutMs / 1000),
      disabled: config.sandbox.disabled,
    },
    jobs: {
      maxRetries: config.jobs.maxRetries,
      workerMode: config.jobs.workerMode,
      workerConcurrency: config.jobs.workerConcurrency,
    },
    emailProvider: config.email.provider,
    billing: {
      provider: config.billing.provider,
      currency: config.billing.currency,
      proConfigured: Boolean(config.billing.priceIds.pro),
      businessConfigured: Boolean(config.billing.priceIds.business),
      deletionPolicy: config.billing.deletionPolicy,
    },
  };
}

export function isProduction(): boolean {
  return getConfig().appEnv === "production";
}
