import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig, resetConfigCache } from "@/lib/config/env";
import { API_CONTENT_SECURITY_POLICY, buildContentSecurityPolicy, generateNonce } from "@/lib/security/csp";
import { enforceRateLimit } from "@/lib/auth/rate-limit-policy";
import { resetRateLimit } from "@/lib/auth/rate-limit";
import { AppError, classifyError, toErrorCode } from "@/lib/observability/errors";
import { log, redactValue, resolveRequestId, setLogSink } from "@/lib/observability/logger";
import { collectReadiness } from "@/lib/observability/readiness";
import { getDb } from "@/lib/db/client";
import { issuePasswordReset } from "@/lib/auth/password-reset-service";
import { hashToken } from "@/lib/auth/tokens";
import { findPasswordReset } from "@/lib/db/repositories/password-resets";
import { getJobById } from "@/lib/db/repositories/jobs";
import { JobWorker } from "@/lib/jobs/worker";
import { createEmailHandler } from "@/lib/jobs/handlers/email";
import { setEmailProviderForTests, sendEmail } from "@/lib/email/email-service";
import type { EmailMessage, EmailProvider } from "@/lib/email/types";
import { runCleanup } from "@/lib/jobs/cleanup";
import { deleteAccount } from "@/lib/account/deletion";
import { createSession } from "@/lib/db/repositories/sessions";
import { findUserById } from "@/lib/db/repositories/users";
import { storeExtensionPackage } from "@/lib/packages/service";
import { createQueuedTestRun } from "@/lib/testing/run-service";
import { getStorage } from "@/lib/storage/storage";
import { getPackageById } from "@/lib/db/repositories/packages";
import { getTestRunById } from "@/lib/db/repositories/test-runs";
import JSZip from "jszip";
import { setupHarness, makeUser, type Harness } from "./helpers";

const prodBase: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  APP_ENV: "production",
  APP_URL: "https://lab.example.com",
  SESSION_SECRET: "s".repeat(48),
  EMAIL_PROVIDER: "noop",
  DATABASE_URL: "sqlite:/tmp/el-config-test.sqlite",
  PATH: process.env.PATH,
};

describe("environment configuration", () => {
  afterEach(() => resetConfigCache());

  it("accepts a complete production configuration", () => {
    const config = loadConfig({ ...prodBase });
    expect(config.appEnv).toBe("production");
    expect(config.jobs.workerMode).toBe("external");
    expect(config.email.provider).toBe("noop");
    expect(config.sandbox.maxConcurrency).toBe(4);
    expect(config.sandbox.userConcurrency).toBe(1);
  });

  it("fails production startup when mandatory secrets or safe settings are missing", () => {
    expect(() => loadConfig({ ...prodBase, SESSION_SECRET: undefined })).toThrow(ConfigError);
    expect(() => loadConfig({ ...prodBase, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...prodBase, APP_URL: "http://lab.example.com" })).toThrow(/https/);
    expect(() => loadConfig({ ...prodBase, EMAIL_PROVIDER: undefined })).toThrow(/EMAIL_PROVIDER/);
    expect(() => loadConfig({ ...prodBase, EMAIL_PROVIDER: "console" })).toThrow(/not allowed in production/);
    expect(() => loadConfig({ ...prodBase, EMAIL_PROVIDER: "http" })).toThrow(/EMAIL_HTTP_URL/);
    expect(() => loadConfig({ ...prodBase, EXTENSIONLAB_RESET_DEV_DIR: "/tmp/x" })).toThrow(/RESET_DEV_DIR/);
  });

  it("does not crash development on problems and parses the documented variables", () => {
    const config = loadConfig({
      NODE_ENV: "development",
      APP_ENV: "development",
      SANDBOX_MAX_CONCURRENCY: "6",
      SANDBOX_USER_CONCURRENCY: "2",
      SANDBOX_TIMEOUT: "90",
      JOB_MAX_RETRIES: "5",
      RATE_LIMIT_LOGIN_PER_MIN: "7",
      STORAGE_PATH: "/tmp/el-storage",
      PATH: process.env.PATH,
    });
    expect(config.sandbox.maxConcurrency).toBe(6);
    expect(config.sandbox.userConcurrency).toBe(2);
    expect(config.sandbox.timeoutMs).toBe(90_000);
    expect(config.jobs.maxRetries).toBe(5);
    expect(config.rateLimits.login).toBe(7);
    expect(config.storage.path).toBe("/tmp/el-storage");
  });

  it("ships an .env.example that contains placeholders only", () => {
    const example = readFileSync(join(process.cwd(), ".env.example"), "utf8");
    for (const key of ["APP_ENV", "APP_URL", "DATABASE_URL", "SESSION_SECRET", "STORAGE_PROVIDER", "STORAGE_PATH", "SANDBOX_IMAGE", "SANDBOX_MAX_CONCURRENCY", "SANDBOX_TIMEOUT", "JOB_MAX_RETRIES", "EMAIL_PROVIDER", "RATE_LIMIT_LOGIN_PER_MIN"]) {
      expect(example, key).toMatch(new RegExp(`^${key}=`, "m"));
    }
    expect(example).toMatch(/SESSION_SECRET=replace-with/);
    expect(example).not.toMatch(/sk_live|BEGIN (RSA|OPENSSH) PRIVATE KEY|AKIA[0-9A-Z]{16}/);
  });
});

describe("content security policy", () => {
  it("nonce-gates scripts and never allows unsafe-eval in production", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9]{24,}$/);
    const csp = buildContentSecurityPolicy({ nonce, upgradeInsecureRequests: true });
    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(buildContentSecurityPolicy({ nonce, development: true })).toContain("'unsafe-eval'");
    expect(API_CONTENT_SECURITY_POLICY).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it("generates unique nonces", () => {
    expect(new Set(Array.from({ length: 50 }, () => generateNonce())).size).toBe(50);
  });
});

describe("rate-limit policy", () => {
  let harness: Harness;
  beforeEach(() => {
    harness = setupHarness({ RATE_LIMIT_FORGOT_PASSWORD_PER_MIN: "2", RATE_LIMIT_LOGIN_PER_MIN: "3" });
  });
  afterEach(() => {
    resetRateLimit("forgotPassword:1.2.3.4");
    resetRateLimit("login:1.2.3.4");
    harness.teardown();
  });

  it("applies configurable per-action limits keyed by client", () => {
    expect(enforceRateLimit("forgotPassword", "1.2.3.4").ok).toBe(true);
    expect(enforceRateLimit("forgotPassword", "1.2.3.4").ok).toBe(true);
    const blocked = enforceRateLimit("forgotPassword", "1.2.3.4");
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    // Other actions and other clients have independent buckets.
    expect(enforceRateLimit("login", "1.2.3.4").ok).toBe(true);
    expect(enforceRateLimit("forgotPassword", "5.6.7.8").ok).toBe(true);
    resetRateLimit("forgotPassword:5.6.7.8");
  });

  it("covers every sensitive route with the central policy", () => {
    const apiRoot = join(process.cwd(), "app", "api");
    const expectations: Record<string, string> = {
      "auth/login/route.ts": "login",
      "auth/signup/route.ts": "signup",
      "auth/forgot-password/route.ts": "forgotPassword",
      "auth/reset-password/route.ts": "resetPassword",
      "extensions/route.ts": "upload",
      "tests/create/route.ts": "testCreate",
      "sandbox/create/route.ts": "sandboxCreate",
      "reports/[id]/share/route.ts": "shareCreate",
      "reports/route.ts": "reportCreate",
    };
    for (const [file, action] of Object.entries(expectations)) {
      const source = readFileSync(join(apiRoot, file), "utf8");
      expect(source, file).toContain(`enforceRateLimit("${action}"`);
    }
    const publicReport = readFileSync(join(process.cwd(), "app", "report", "shared", "[token]", "page.tsx"), "utf8");
    expect(publicReport).toContain('enforceRateLimit("publicReport"');
  });
});

describe("error catalog and structured logging", () => {
  it("maps infrastructure failures to stable codes with safe user messages", () => {
    const sandbox = classifyError(new AppError("SANDBOX_UNAVAILABLE"));
    expect(sandbox.code).toBe("SANDBOX_UNAVAILABLE");
    expect(sandbox.userMessage).toMatch(/isolated browser environment/);
    expect(sandbox.retryable).toBe(true);
    expect(classifyError(Object.assign(new Error("x"), { code: "ENOSPC" }))).toMatchObject({ code: "STORAGE_ERROR", retryable: true });
    expect(classifyError(new Error("stack at /home/user/app/lib/x.ts:12"))).toMatchObject({ code: "INTERNAL", retryable: false });
    expect(classifyError(new Error("stack at /home/user/app/lib/x.ts:12")).userMessage).not.toContain("/home/user");
    for (const code of ["AUTH_REQUIRED", "FORBIDDEN", "INVALID_EXTENSION", "STORAGE_ERROR", "JOB_TIMEOUT", "SANDBOX_UNAVAILABLE", "SANDBOX_TIMEOUT", "TEST_FAILED", "QUOTA_EXCEEDED", "RATE_LIMITED"] as const) {
      expect(toErrorCode(code)).toBe(code);
    }
    expect(toErrorCode("something-unknown")).toBe("INTERNAL");
  });

  it("redacts secrets and never emits tokens, cookies or auth headers", () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    try {
      log("error", "test.event", {
        requestId: "req_abc123",
        userId: "usr_1",
        password: "hunter2",
        token: "tok_secret",
        cookie: "session=abc",
        authorization: "Bearer xyz",
        nested: { apiKey: "key_123", ok: "fine" },
        errorCode: "INTERNAL",
      });
    } finally {
      setLogSink(null);
    }
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(record).toMatchObject({ level: "error", event: "test.event", requestId: "req_abc123", userId: "usr_1", errorCode: "INTERNAL" });
    expect(typeof record.ts).toBe("string");
    for (const secret of ["hunter2", "tok_secret", "session=abc", "Bearer xyz", "key_123"]) {
      expect(lines[0]).not.toContain(secret);
    }
    expect(redactValue("password", "x")).toBe("[redacted]");
    expect(redactValue("count", 3)).toBe(3);
  });

  it("accepts well-formed inbound request ids and generates safe ones otherwise", () => {
    expect(resolveRequestId("req_ABCdef-123.x")).toBe("req_ABCdef-123.x");
    expect(resolveRequestId("<script>alert(1)</script>")).toMatch(/^req_[a-z0-9]+$/);
    expect(resolveRequestId(null)).toMatch(/^req_[a-z0-9]+$/);
    expect(resolveRequestId("a".repeat(200))).toMatch(/^req_[a-z0-9]+$/);
  });
});

describe("health and readiness", () => {
  let harness: Harness;
  beforeEach(() => {
    harness = setupHarness({ SANDBOX_DISABLED: "true", WORKER_MODE: "external" });
  });
  afterEach(() => harness.teardown());

  it("reports dependencies without leaking internals and distinguishes Docker availability", async () => {
    const report = await collectReadiness();
    expect(report.checks.database.status).toBe("ok");
    expect(report.checks.database.migrationsPending).toBe(0);
    expect(report.checks.storage).toEqual({ status: "ok", provider: "local" });
    expect(report.checks.worker.status).toBe("unavailable");
    expect(report.checks.sandbox.available).toBe(false);
    expect(report.checks.sandbox.reason).toBe("disabled");
    expect(report.capabilities.staticAnalysis).toBe(true);
    expect(report.capabilities.automatedTests).toBe(false);
    expect(typeof report.capabilities.aiAssistance).toBe("boolean");
    expect(report.status).toBe("degraded");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(harness.dir);
    expect(serialized).not.toMatch(/docker\.sock|containerId|hostname/i);
  });

  it("reports a live worker from heartbeats", async () => {
    const worker = new JobWorker({ workerId: "w-ready", concurrency: 1, pollIntervalMs: 10, sandboxProbe: async () => ({ available: true }) });
    worker.register(createEmailHandler());
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const report = await collectReadiness();
    await worker.stop();
    expect(report.checks.worker.status).toBe("ok");
    expect(report.checks.worker.live).toBe(1);
    expect(report.checks.sandbox.available).toBe(true);
    expect(report.capabilities.automatedTests).toBe(true);
    expect(report.status).toBe("ok");
  });
});

class RecordingEmailProvider implements EmailProvider {
  readonly name = "recording";
  sent: EmailMessage[] = [];
  failures = 0;
  async send(message: EmailMessage) {
    if (this.failures > 0) {
      this.failures -= 1;
      return { ok: false, transient: true, detail: "relay_timeout" };
    }
    this.sent.push(message);
    return { ok: true, providerMessageId: `m${this.sent.length}` };
  }
  async healthCheck() {
    return { ok: true };
  }
}

describe("password reset via queued e-mail", () => {
  let harness: Harness;
  let provider: RecordingEmailProvider;
  beforeEach(() => {
    harness = setupHarness({ EMAIL_PROVIDER: "console", APP_URL: "http://localhost:3000" });
    provider = new RecordingEmailProvider();
    setEmailProviderForTests(provider);
  });
  afterEach(() => harness.teardown());

  it("stores only the token hash, queues one EMAIL job and never logs the raw token", async () => {
    const user = makeUser("reset@example.com");
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    try {
      await issuePasswordReset({ id: user.id, email: user.email });
    } finally {
      setLogSink(null);
    }
    const jobs = getDb().prepare("SELECT * FROM jobs WHERE type = 'EMAIL'").all() as Array<{ id: string; payload_json: string; user_id: string }>;
    expect(jobs).toHaveLength(1);
    const payload = JSON.parse(jobs[0].payload_json) as { to: string; variables: { resetUrl: string } };
    const token = new URL(payload.variables.resetUrl).searchParams.get("token")!;
    expect(token.length).toBeGreaterThanOrEqual(32);
    const row = findPasswordReset(hashToken(token));
    expect(row).not.toBeNull();
    expect(row!.user_id).toBe(user.id);
    expect(row!.expires_at).toBeGreaterThan(Date.now() + 25 * 60 * 1000);
    const resets = getDb().prepare("SELECT token_hash FROM password_resets").all() as Array<{ token_hash: string }>;
    expect(resets.every((reset) => reset.token_hash !== token)).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain(token);
      expect(line).not.toContain("reset@example.com");
    }

    const worker = new JobWorker({ workerId: "w-mail", concurrency: 1, pollIntervalMs: 10 });
    worker.register(createEmailHandler());
    expect(await worker.tick()).toBe(true);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].to).toBe("reset@example.com");
    expect(provider.sent[0].text).toContain(token);
    expect(getJobById(jobs[0].id)).toMatchObject({ status: "completed", payload_json: JSON.stringify({ redacted: true }) });
  });

  it("retries transient delivery failures and completes afterwards", async () => {
    const user = makeUser();
    provider.failures = 1;
    await issuePasswordReset({ id: user.id, email: user.email });
    const job = (getDb().prepare("SELECT id FROM jobs WHERE type = 'EMAIL'").get() as { id: string }).id;
    const worker = new JobWorker({ workerId: "w-mail2", concurrency: 1, pollIntervalMs: 10 });
    worker.register(createEmailHandler());
    await worker.tick();
    expect(getJobById(job)).toMatchObject({ status: "retrying", error_code: "EMAIL_DELIVERY_FAILED", attempts: 1 });
    // Payload is kept while a retry is pending (the link is still needed).
    expect(getJobById(job)!.payload_json).not.toContain("redacted");
    getDb().prepare("UPDATE jobs SET run_after = ? WHERE id = ?").run(Date.now() - 1, job);
    await worker.tick();
    expect(getJobById(job)).toMatchObject({ status: "completed", attempts: 2 });
    expect(provider.sent).toHaveLength(1);
  });

  it("surfaces delivery failures as a stable error code without provider details", async () => {
    setEmailProviderForTests({
      name: "broken",
      async send() {
        return { ok: false, transient: false, detail: "smtp 550 relay denied by mx1.internal" };
      },
      async healthCheck() {
        return { ok: false };
      },
    });
    const error = await sendEmail({ to: "a@b.c", subject: "s", text: "t", html: "<p>t</p>" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("EMAIL_DELIVERY_FAILED");
    expect((error as AppError).retryable).toBe(false);
    expect(classifyError(error).userMessage).not.toMatch(/smtp|mx1|relay/);
  });
});

async function fixtureZip(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({ manifest_version: 3, name: "Cleanup", version: "1.0.0", background: { service_worker: "bg.js" } }));
  zip.file("bg.js", "console.log('bg')");
  return zip.generateAsync({ type: "uint8array" });
}

describe("retention cleanup and account deletion", () => {
  let harness: Harness;
  beforeEach(() => {
    harness = setupHarness({ PACKAGE_RETENTION_DAYS: "1", JOB_RETENTION_DAYS: "1", STALE_JOB_DAYS: "1", STALE_RUN_MINUTES: "30" });
  });
  afterEach(() => harness.teardown());

  it("removes only data past its retention window", async () => {
    const user = makeUser();
    const fresh = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "fresh.zip" });
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify({ manifest_version: 3, name: "Old", version: "0.0.1", background: { service_worker: "bg.js" } }));
    zip.file("bg.js", "1");
    const old = await storeExtensionPackage({ userId: user.id, bytes: await zip.generateAsync({ type: "uint8array" }), fileName: "old.zip" });
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    getDb().prepare("UPDATE extension_packages SET created_at = ?, last_used_at = ? WHERE id = ?").run(twoDaysAgo, twoDaysAgo, old.package.id);
    const oldKey = getPackageById(old.package.id)!.storage_key;

    // A stale queued job and a finished old job.
    getDb()
      .prepare(
        `INSERT INTO jobs (id, type, user_id, status, attempts, max_attempts, payload_json, priority, run_after, created_at, updated_at, finished_at)
         VALUES ('job_stale', 'EMAIL', ?, 'queued', 0, 4, '{}', 0, ?, ?, ?, NULL),
                ('job_old', 'EMAIL', ?, 'completed', 1, 4, '{}', 0, ?, ?, ?, ?)`,
      )
      .run(user.id, twoDaysAgo, twoDaysAgo, twoDaysAgo, user.id, twoDaysAgo, twoDaysAgo, twoDaysAgo, twoDaysAgo);
    // A stale active run (no updates for an hour) with an open reservation.
    const created = createQueuedTestRun({ userId: user.id, packageId: fresh.package.id, analysis: fresh.analysis, extensionId: null });
    getDb().prepare("UPDATE test_runs SET status = 'running', updated_at = ? WHERE id = ?").run(Date.now() - 60 * 60 * 1000, created.runId);

    const report = await runCleanup();
    expect(report.expiredPackages + report.orphanedPackages).toBe(1);
    expect(getPackageById(old.package.id)).toBeNull();
    expect(await getStorage().exists(oldKey)).toBe(false);
    expect(getPackageById(fresh.package.id)?.status).toBe("stored");
    expect(report.staleJobsExpired).toBe(1);
    expect(getJobById("job_stale")?.status).toBe("expired");
    expect(report.finishedJobsDeleted).toBe(1);
    expect(getJobById("job_old")).toBeNull();
    expect(report.staleRunsFinalized).toBe(1);
    expect(getTestRunById(created.runId)).toMatchObject({ status: "failed", outcome: "INFRASTRUCTURE_ERROR", error_code: "WORKER_UNAVAILABLE" });
    // Idempotent.
    const second = await runCleanup();
    expect(second.staleJobsExpired).toBe(0);
    expect(second.staleRunsFinalized).toBe(0);
  });

  it("deletes an account with all owned rows and blobs in one pass", async () => {
    const user = makeUser();
    const other = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "mine.zip" });
    const theirs = await storeExtensionPackage({ userId: other.id, bytes: await fixtureZip(), fileName: "theirs.zip" });
    createSession({ userId: user.id, tokenHash: hashToken("session-token-1"), ttlMs: 60_000 });
    const created = createQueuedTestRun({ userId: user.id, packageId: stored.package.id, analysis: stored.analysis, extensionId: null });
    const key = getPackageById(stored.package.id)!.storage_key;

    const result = await deleteAccount(user.id);
    expect(result.blobsDeleted).toBe(1);
    expect(result.blobsFailed).toBe(0);
    expect(findUserById(user.id)).toBeNull();
    expect(getPackageById(stored.package.id)).toBeNull();
    expect(getTestRunById(created.runId)).toBeNull();
    expect(getJobById(created.jobId)).toBeNull();
    expect(await getStorage().exists(key)).toBe(false);
    const count = (table: string) => (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(user.id) as { n: number }).n;
    for (const table of ["sessions", "quota_reservations", "extension_packages", "test_runs", "jobs", "artifacts"]) {
      expect(count(table), table).toBe(0);
    }
    // Other users are untouched.
    expect(getPackageById(theirs.package.id)?.status).toBe("stored");
    expect(findUserById(other.id)).not.toBeNull();
  });
});
