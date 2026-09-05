import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { JobWorker } from "@/lib/jobs/worker";
import { backoffDelay, decideRetry } from "@/lib/jobs/retry";
import { cancelJob, enqueueJob, getJobEventsAfter, getOwnedJobView } from "@/lib/jobs/queue";
import { getJobById, listExpiredLeases, type JobRow } from "@/lib/db/repositories/jobs";
import { AppError } from "@/lib/observability/errors";
import type { JobContext, JobHandler } from "@/lib/jobs/types";
import { setupHarness, makeUser, type Harness } from "./helpers";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function emailHandler(impl: (context: JobContext<"EMAIL">) => Promise<Record<string, unknown> | void>, extra: Partial<JobHandler<"EMAIL">> = {}): JobHandler<"EMAIL"> {
  return { type: "EMAIL", handle: impl, ...extra };
}

function enqueueEmail(userId: string | null, extra: Partial<Parameters<typeof enqueueJob<"EMAIL">>[0]> = {}) {
  return enqueueJob({
    type: "EMAIL",
    userId,
    payload: { template: "password-reset", to: "someone@example.com", variables: { resetUrl: "https://x/reset?token=secret" } },
    ...extra,
  }).job;
}

describe("retry policy", () => {
  it("uses exponential backoff 1s, 2s, 4s, 8s with a cap", () => {
    expect(backoffDelay(1, { jitter: false })).toBe(1000);
    expect(backoffDelay(2, { jitter: false })).toBe(2000);
    expect(backoffDelay(3, { jitter: false })).toBe(4000);
    expect(backoffDelay(4, { jitter: false })).toBe(8000);
    expect(backoffDelay(20, { jitter: false })).toBe(60_000);
    const jittered = backoffDelay(3);
    expect(jittered).toBeGreaterThanOrEqual(4000);
    expect(jittered).toBeLessThanOrEqual(4400);
  });

  it("retries only transient failures while attempts remain", () => {
    const transient = new AppError("SANDBOX_UNAVAILABLE", { retryable: true });
    expect(decideRetry(transient, 1, 4)).toMatchObject({ retry: true, delayMs: expect.any(Number), code: "SANDBOX_UNAVAILABLE" });
    expect(decideRetry(transient, 4, 4).retry).toBe(false);
    expect(decideRetry(new AppError("INVALID_EXTENSION"), 1, 4).retry).toBe(false);
    expect(decideRetry(new AppError("FORBIDDEN"), 1, 4).retry).toBe(false);
    const econn = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:2375"), { code: "ECONNREFUSED" });
    expect(decideRetry(econn, 1, 4)).toMatchObject({ retry: true, code: "SANDBOX_UNAVAILABLE" });
    expect(decideRetry(new Error("kaboom"), 1, 4)).toMatchObject({ retry: false, code: "INTERNAL" });
  });
});

describe("job queue", () => {
  let harness: Harness;
  beforeEach(() => {
    harness = setupHarness({ JOB_MAX_QUEUED_PER_USER: "2", JOB_MAX_QUEUE_LENGTH: "3" });
  });
  afterEach(() => harness.teardown());

  it("creates persistent jobs with the documented shape", () => {
    const user = makeUser();
    const job = enqueueEmail(user.id);
    expect(job.id).toMatch(/^job_/);
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(job.max_attempts).toBe(4);
    const view = getOwnedJobView(user.id, job.id)!;
    expect(view).toMatchObject({ id: job.id, type: "EMAIL", status: "queued", attempts: 0, maxAttempts: 4, queuePosition: 1 });
    expect(JSON.stringify(view)).not.toContain("secret");
    expect(getOwnedJobView(makeUser().id, job.id)).toBeNull();
  });

  it("is idempotent on idempotency keys", () => {
    const user = makeUser();
    const first = enqueueJob({ type: "EMAIL", userId: user.id, payload: { template: "password-reset", to: "a@b.c", variables: {} }, idempotencyKey: "k1" });
    const second = enqueueJob({ type: "EMAIL", userId: user.id, payload: { template: "password-reset", to: "a@b.c", variables: {} }, idempotencyKey: "k1" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
  });

  it("applies per-user and global back-pressure", () => {
    const user = makeUser();
    enqueueEmail(user.id);
    enqueueEmail(user.id);
    expect(() => enqueueEmail(user.id)).toThrow(/maximum number of queued/);
    const other = makeUser();
    enqueueEmail(other.id);
    expect(() => enqueueEmail(makeUser().id)).toThrowError(expect.objectContaining({ code: "QUEUE_FULL" }));
    // Maintenance jobs bypass back-pressure.
    expect(enqueueJob({ type: "ARTIFACT_CLEANUP", userId: null, payload: {}, skipBackpressure: true }).created).toBe(true);
  });

  it("cancels queued jobs immediately and idempotently", () => {
    const job = enqueueEmail(makeUser().id);
    expect(cancelJob(job.id)).toEqual({ status: "cancelled", changed: true });
    expect(cancelJob(job.id)).toEqual({ status: "cancelled", changed: false });
    expect(getJobById(job.id)?.status).toBe("cancelled");
  });
});

describe("job worker", () => {
  let harness: Harness;
  beforeEach(() => {
    harness = setupHarness({ JOB_MAX_QUEUED_PER_USER: "10", JOB_MAX_QUEUE_LENGTH: "100" });
  });
  afterEach(() => harness.teardown());

  it("runs a job to completion, records events and redacts finished payloads", async () => {
    const user = makeUser();
    const job = enqueueEmail(user.id);
    const worker = new JobWorker({ workerId: "w-test", concurrency: 1, pollIntervalMs: 10, leaseMs: 5000, jobTimeoutMs: 5000 });
    const seen: string[] = [];
    worker.register(
      emailHandler(
        async (context) => {
          seen.push(context.payload.to);
          context.emit("stage", { type: "stage", stage: "Sending" }, "Sending");
          return { delivered: true };
        },
        { redactPayloadOnFinish: true },
      ),
    );
    expect(await worker.tick()).toBe(true);
    expect(seen).toEqual(["someone@example.com"]);

    const row = getJobById(job.id)!;
    expect(row.status).toBe("completed");
    expect(row.attempts).toBe(1);
    expect(row.finished_at).not.toBeNull();
    expect(row.payload_json).toBe(JSON.stringify({ redacted: true }));
    expect(JSON.parse(row.result_json ?? "{}")).toEqual({ delivered: true });

    const events = getJobEventsAfter(job.id, 0).map((event) => JSON.parse(event.payload));
    expect(events.map((event) => event.state ?? event.stage)).toEqual(["queued", "running", "Sending", "completed"]);
    expect(await worker.tick()).toBe(false);
  });

  it("retries transient failures with backoff and fails permanently after max attempts", async () => {
    const user = makeUser();
    const job = enqueueEmail(user.id, { maxAttempts: 2 });
    const worker = new JobWorker({ workerId: "w-retry", concurrency: 1, pollIntervalMs: 10, leaseMs: 5000, jobTimeoutMs: 5000 });
    let calls = 0;
    worker.register(
      emailHandler(async () => {
        calls += 1;
        throw new AppError("EMAIL_DELIVERY_FAILED", { retryable: true, message: "relay down" });
      }),
    );

    expect(await worker.tick()).toBe(true);
    let row = getJobById(job.id)!;
    expect(row.status).toBe("retrying");
    expect(row.attempts).toBe(1);
    expect(row.error_code).toBe("EMAIL_DELIVERY_FAILED");
    expect(row.run_after).toBeGreaterThanOrEqual(Date.now() + 900);
    // Not claimable until run_after.
    expect(await worker.tick()).toBe(false);

    getDb().prepare("UPDATE jobs SET run_after = ? WHERE id = ?").run(Date.now() - 1, job.id);
    expect(await worker.tick()).toBe(true);
    row = getJobById(job.id)!;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(2);
    expect(calls).toBe(2);
    const states = getJobEventsAfter(job.id, 0).map((event) => JSON.parse(event.payload).state);
    expect(states).toEqual(["queued", "running", "retrying", "running", "failed"]);
  });

  it("never retries permanent failures", async () => {
    const job = enqueueEmail(makeUser().id);
    const worker = new JobWorker({ workerId: "w-perm", concurrency: 1, pollIntervalMs: 10, leaseMs: 5000, jobTimeoutMs: 5000 });
    worker.register(
      emailHandler(async () => {
        throw new AppError("INVALID_EXTENSION");
      }),
    );
    await worker.tick();
    const row = getJobById(job.id)!;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.error_code).toBe("INVALID_EXTENSION");
  });

  it("times out stuck jobs with JOB_TIMEOUT and invokes cancel", async () => {
    const job = enqueueEmail(makeUser().id);
    const worker = new JobWorker({ workerId: "w-timeout", concurrency: 1, pollIntervalMs: 10, leaseMs: 5000, jobTimeoutMs: 50 });
    let cancelled = 0;
    worker.register(
      emailHandler(
        (context) =>
          new Promise((_, reject) => {
            context.signal.addEventListener("abort", () => reject(context.signal.reason));
          }),
        {
          async cancel() {
            cancelled += 1;
          },
        },
      ),
    );
    await worker.tick();
    const row = getJobById(job.id)!;
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("JOB_TIMEOUT");
    expect(cancelled).toBe(1);
  });

  it("cancels a running job cooperatively and idempotently", async () => {
    const job = enqueueEmail(makeUser().id);
    const worker = new JobWorker({ workerId: "w-cancel", concurrency: 1, pollIntervalMs: 10, leaseMs: 5000, jobTimeoutMs: 5000 });
    let cancelCalls = 0;
    worker.register(
      emailHandler(
        async (context) => {
          while (!context.isCancelled()) await sleep(5);
          return { stopped: true };
        },
        {
          async cancel() {
            cancelCalls += 1;
          },
        },
      ),
    );
    const running = worker.tick();
    await sleep(30);
    expect(getJobById(job.id)?.status).toBe("running");
    expect(cancelJob(job.id)).toEqual({ status: "running", changed: true });
    // Second cancel while still running is a no-op.
    expect(cancelJob(job.id).changed).toBe(false);
    await running;
    const row = getJobById(job.id)!;
    expect(row.status).toBe("cancelled");
    expect(cancelCalls).toBe(1);
    expect(cancelJob(job.id)).toEqual({ status: "cancelled", changed: false });
  });

  it("enforces per-user concurrency for AUTOMATED_TEST while allowing other users", async () => {
    const alice = makeUser();
    const bob = makeUser();
    const mk = (userId: string, runId: string) =>
      enqueueJob({
        type: "AUTOMATED_TEST",
        userId,
        payload: { runId, packageId: "pkg_x", extensionId: null, testIds: [], reservationId: null },
      }).job;
    const a1 = mk(alice.id, "run_a1");
    const a2 = mk(alice.id, "run_a2");
    const b1 = mk(bob.id, "run_b1");

    const worker = new JobWorker({ workerId: "w-conc", concurrency: 3, userConcurrency: 1, pollIntervalMs: 10, leaseMs: 5000, jobTimeoutMs: 5000 });
    const release = new Map<string, () => void>();
    worker.register({
      type: "AUTOMATED_TEST",
      handle: (context) =>
        new Promise<void>((resolve) => {
          release.set(context.payload.runId, resolve);
        }),
    });
    worker.start();
    await sleep(100);
    expect(getJobById(a1.id)?.status).toBe("running");
    expect(getJobById(b1.id)?.status).toBe("running");
    expect(getJobById(a2.id)?.status).toBe("queued");
    release.get("run_a1")!();
    await sleep(100);
    expect(getJobById(a2.id)?.status).toBe("running");
    release.get("run_a2")!();
    release.get("run_b1")!();
    await sleep(50);
    await worker.stop();
    expect(getJobById(a2.id)?.status).toBe("completed");
  });

  it("recovers orphaned jobs from a crashed worker on startup", async () => {
    const job = enqueueEmail(makeUser().id);
    // Simulate a worker that claimed the job and died: lease already expired.
    getDb()
      .prepare("UPDATE jobs SET status = 'running', worker_id = 'w-dead', lease_expires_at = ?, attempts = 1 WHERE id = ?")
      .run(Date.now() - 1000, job.id);
    expect(listExpiredLeases().map((row: JobRow) => row.id)).toEqual([job.id]);

    const worker = new JobWorker({ workerId: "w-new", concurrency: 1, pollIntervalMs: 10, leaseMs: 5000, jobTimeoutMs: 5000 });
    let handled = 0;
    worker.register(emailHandler(async () => void (handled += 1)));
    expect(worker.recoverOrphans("startup")).toBe(1);
    let row = getJobById(job.id)!;
    expect(row.status).toBe("retrying");
    expect(row.error_code).toBe("WORKER_UNAVAILABLE");
    expect(row.worker_id).toBeNull();

    await worker.tick();
    row = getJobById(job.id)!;
    expect(row.status).toBe("completed");
    expect(row.attempts).toBe(2);
    expect(handled).toBe(1);
  });

  it("fails an orphan that has no attempts left", () => {
    const job = enqueueEmail(makeUser().id, { maxAttempts: 1 });
    getDb()
      .prepare("UPDATE jobs SET status = 'running', worker_id = 'w-dead', lease_expires_at = ?, attempts = 1 WHERE id = ?")
      .run(Date.now() - 1000, job.id);
    const worker = new JobWorker({ workerId: "w-new2", concurrency: 1, pollIntervalMs: 10 });
    worker.register(emailHandler(async () => undefined));
    worker.recoverOrphans("sweep");
    expect(getJobById(job.id)).toMatchObject({ status: "failed", error_code: "WORKER_UNAVAILABLE" });
  });

  it("stops gracefully: finishes in-flight work and reschedules abandoned jobs", async () => {
    const quick = enqueueEmail(makeUser().id);
    const slow = enqueueEmail(makeUser().id);
    const worker = new JobWorker({ workerId: "w-stop", concurrency: 2, pollIntervalMs: 10, leaseMs: 5000, jobTimeoutMs: 5000, shutdownGraceMs: 100 });
    worker.register(
      emailHandler(async (context) => {
        if (context.job.id === quick.id) return { ok: true };
        // Ignores cancellation for longer than the grace period.
        await sleep(400);
        return { ok: true };
      }),
    );
    worker.start();
    await sleep(60);
    expect(worker.activeCount).toBe(1);
    await worker.stop();
    expect(worker.isRunning).toBe(false);
    expect(getJobById(quick.id)?.status).toBe("completed");
    const abandoned = getJobById(slow.id)!;
    expect(["retrying", "cancelled"]).toContain(abandoned.status);
    // Second stop is a no-op.
    await worker.stop();
    await sleep(400);
  });
});
