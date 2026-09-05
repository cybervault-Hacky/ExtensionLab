# Architecture

ExtensionLab is a Next.js 15 / React 19 application with a Node.js worker,
SQLite (`node:sqlite`), a filesystem storage provider and Docker-isolated
Chromium sandboxes. This document describes the Phase 6 production
architecture and how it composes the earlier phases without replacing them.

## Components

| Component | Location | Responsibility |
| --- | --- | --- |
| Web (Next.js) | `app/`, `components/`, `middleware.ts` | UI, REST/SSE API, auth, CSP, rate limits, enqueueing jobs |
| Worker | `scripts/worker.ts`, `lib/jobs/` | Claims jobs, runs automated tests in Docker, sends e-mail, cleanup |
| Analyzer (Phase 1/2) | `lib/extension/` | ZIP validation and static analysis — never executes code |
| Sandbox (Phase 3) | `lib/runtime/`, `sandbox/` | `SandboxManager` + Docker driver + in-container runner (CDP) |
| Test engine (Phase 4) | `lib/testing/` | Deterministic test registry, actions, assertions, scoring, diagnostics |
| Workspace (Phase 5) | `lib/db/`, `lib/auth/` | Users, sessions, extensions, snapshots, runs, reports, shares, usage |
| Storage | `lib/storage/` | Opaque-key blob storage for packages and artifacts |
| Jobs | `lib/jobs/` | Queue, worker, retry policy, scheduler, cleanup |
| Config / observability | `lib/config/env.ts`, `lib/observability/` | Validated env, logger, error catalog, readiness |
| E-mail | `lib/email/` | Provider abstraction and templates |

## Request flow: uploading and testing an extension

```text
1. POST /api/extensions (multipart ZIP)
   ├─ rate limit (upload), session auth, same-origin check
   ├─ analyzeZipBytes()            Phase 1/2 validation + static analysis
   ├─ storeExtensionPackage()      put → get → sha256 verify → extension_packages row
   └─ extension + analysis_snapshot rows (Phase 5), package linked to both

2. POST /api/tests/create { extensionId | packageId }
   └─ createQueuedTestRun()  — ONE transaction:
        countActiveTestRunsForUser  → CONCURRENCY_LIMIT
        createTestRun(status=queued, stage=Queued, package_id)
        reserveQuota(kind=test_run) → QUOTA_EXCEEDED (rolls everything back)
        enqueueJob(AUTOMATED_TEST, idempotencyKey=test_run:<runId>)
        attachJobToTestRun, access_token_hash (per-run live token)
      → 201 { runId, token, jobId, status: "queued" }   (request returns immediately)

3. Worker claims the job (conditional UPDATE … RETURNING, lease + heartbeat)
   ├─ idempotency guard: finished run → no-op / rethrow recorded infra error
   ├─ stage "Preparing"; pre-flight probeSandboxEnvironment()
   │     docker_missing|disabled  → SANDBOX_UNAVAILABLE (permanent → job failed)
   │     docker_unreachable|image_missing → SANDBOX_UNAVAILABLE (retryable, backoff)
   ├─ readPackageBytes() → analyzeZipBytes() → discoverTests() → extract to SANDBOX_TEMP_ROOT/job_<hex>
   ├─ TestRunManager.create/execute (Phase 4) → SandboxManager (Phase 3) → docker create/cp/start
   │     stages: Starting sandbox → Starting Chromium → Loading extension → Running tests
   │             → Collecting evidence → Generating report → Completed
   │     every stage/test event is appended to job_events (durable SSE source)
   ├─ persistence hooks (lib/testing/persistence.ts):
   │     onStatus  → test_runs.status/stage, consume reservation when sandbox starts
   │     onFinished→ result_json (full results), outcome, score, extension status
   │                 transient failure with attempts left → requeueTestRunForRetry
   ├─ persistRunArtifacts(): screenshots / runtime-log / network-summary → storage + artifacts rows
   └─ finally: manager.release(), rm temp dir, sandbox destroyed by the engine

4. Browser follows progress
   GET /api/tests/:runId/status         → TestRunInfo from test_runs + jobs
   GET /api/tests/:runId/events/stream  → SSE replay of job_events (Last-Event-ID), ping every 15 s
   GET /api/tests/:runId/results        → results, score, diagnostics, artifact summaries (owner)
   POST /api/tests/:runId/stop          → cancelRun(): queued → cancelled now; running → cooperative
```

The web tier reads run state exclusively from the database, so refreshes,
reconnects and web restarts never lose a run, and multiple web replicas see
the same state.

## Job system

```text
queued ──claim──▶ running ──ok──▶ completed
   │                 │  └──transient error, attempts left──▶ retrying ──run_after──▶ running
   │                 ├──permanent error / attempts exhausted──▶ failed
   │                 ├──cancel_requested_at observed──▶ cancelled
   │                 └──JOB_TIMEOUT_MS──▶ failed (JOB_TIMEOUT), run → TIMEOUT
   ├──cancelJob()──▶ cancelled
   └──STALE_JOB_DAYS──▶ expired
```

- **Persistence**: `jobs` (id `job_…`, type, user_id, status, attempts,
  max_attempts, payload_json, result_json, error_code, idempotency_key,
  worker_id, lease_expires_at, run_after, cancel_requested_at, timestamps),
  `job_events` (ordered, durable progress), `workers` (heartbeats).
- **Claiming**: a single `UPDATE … WHERE status IN ('queued','retrying') AND
  run_after <= now … RETURNING *` inside `BEGIN IMMEDIATE`; safe with several
  workers. Per-user `AUTOMATED_TEST` concurrency is enforced by excluding
  users who already hit `SANDBOX_USER_CONCURRENCY`.
- **Leases and recovery**: heartbeats renew `lease_expires_at`. On startup and
  every sweep a worker re-queues (`retrying`, `WORKER_UNAVAILABLE`) or fails
  jobs whose lease expired; runs of failed orphans become
  `INFRASTRUCTURE_ERROR` and their reservation is released.
- **Retries**: `decideRetry()` retries only `retryable` errors
  (`SANDBOX_UNAVAILABLE` when transient, `STORAGE_ERROR`, `CONCURRENCY_LIMIT`,
  `EMAIL_DELIVERY_FAILED` when transient, `ECONNREFUSED`/`ETIMEDOUT`-class
  errors) with `1s · 2^(attempt-1)` capped at 60 s plus ≤10 % jitter.
- **Cancellation**: `requestCancel()` cancels queued jobs immediately and
  flags running ones; handlers poll `context.isCancelled()` (and `force`
  before irreversible steps), stop the sandbox and the worker marks the job
  `cancelled`. Cancelling twice is a no-op.
- **Shutdown**: `SIGTERM`/`SIGINT` → stop claiming → abort + `cancel()` active
  jobs → wait up to `WORKER_SHUTDOWN_GRACE_MS` → reschedule leftovers → remove
  heartbeat row → close DB.
- **Scheduler**: enqueues `ARTIFACT_CLEANUP` with idempotency key
  `cleanup:<window>` every `CLEANUP_INTERVAL_MS`.
- **Embedded mode**: `WORKER_MODE=embedded` runs the same `JobWorker` inside
  the web process (development / single-box). Production uses `external`.

## Result semantics

| Outcome | Meaning | Score |
| --- | --- | --- |
| `PASSED` / `FAILED` / `WARNING` / `SKIPPED` | Tests executed in a real sandbox | real |
| `TIMEOUT` | Sandbox or job time limit hit after execution started | partial, marked |
| `INFRASTRUCTURE_ERROR` | Sandbox never executed tests (Docker missing, image missing, worker crash) | none — `runtime.status = "not-executed"`, no quota consumed |
| `CANCELLED` | Stopped by the owner or shutdown | none |

`result_json.runtime.status` distinguishes executed from not-executed runs;
reports carry `runtimeStatus` and show "Not executed" instead of `0/100`.

## Quota

`quota_reservations` rows are created in the run-creation transaction
(`reserveQuota`: `used + reserved < limit`), consumed when the sandbox
actually starts (`consumeReservationForResource` + `usage_events`), and
released on cancel-while-queued, permanent infrastructure failure, orphan
failure or stale-run cleanup. Deferred retries keep the reservation open.

## Storage and artifacts

- Keys: `extensions/<userId>/<32 hex>.zip`, `artifacts/<runId>/<32 hex>.<ext>`.
  `isValidStorageKey` rejects traversal and absolute paths; the local
  provider resolves inside its root only.
- `extension_packages`: id, user_id, extension_id, storage_key, sha256, size,
  version, status (`stored | deleting | deleted | missing`), timestamps.
  Snapshots (`analysis_snapshots.package_id`) and runs
  (`test_runs.package_id`) reference the exact bytes that were analysed/tested.
- `artifacts`: id, test_run_id, user_id, type (`screenshot | runtime-log |
  network-summary`), storage_key, size, sha256, created_at, expires_at.
  Served only through `/api/artifacts/:id` (owner, `no-store`, `nosniff`,
  sandboxed CSP). Public reports receive counts, never blobs or keys.
- Reconciliation (`reconcilePackages`) marks rows without blobs, deletes
  orphaned blobs older than 10 minutes and finalizes `deleting` rows.

## Data model additions (migration 002)

```text
extension_packages(id, user_id→users, extension_id→extensions, storage_key, sha256, size, version, original_name, status, created_at, updated_at, last_used_at)
jobs(id, type, user_id→users, status, priority, attempts, max_attempts, payload_json, result_json, error_code, error_message, idempotency_key, resource_type, resource_id, worker_id, lease_expires_at, run_after, cancel_requested_at, created_at, updated_at, started_at, finished_at)
job_events(id, job_id→jobs, kind, stage, payload_json, created_at)
workers(id, started_at, last_heartbeat_at, concurrency, active_jobs, sandbox_available, sandbox_detail, stopping)
quota_reservations(id, user_id→users, kind, resource_id, job_id, created_at, consumed_at, released_at)
artifacts(id, test_run_id→test_runs, user_id→users, type, storage_key, size, sha256, label, created_at, expires_at)
test_runs += package_id, job_id, stage, outcome, error_code, reason, access_token_hash, updated_at
analysis_snapshots += package_id
```

All foreign keys cascade on user deletion, which is why `deleteAccount()` is
a single transaction plus best-effort blob deletion.

## Observability

- `lib/observability/logger.ts`: JSON lines with `ts, level, event` and
  context (`requestId, jobId, userId, component, durationMs, result,
  errorCode`). Keys matching secrets (password, token, cookie, authorization,
  api key, session, source, body, payload, *_json …) are replaced with
  `[redacted]` recursively. `withLogContext()` uses `AsyncLocalStorage` so
  request/job ids propagate automatically. `recordMetric()` emits
  `metric.*` events and calls registered hooks.
- `lib/observability/errors.ts`: `AppError(code)` with the stable catalog
  (`AUTH_REQUIRED, FORBIDDEN, NOT_FOUND, INVALID_INPUT, INVALID_EXTENSION,
  STORAGE_ERROR, QUOTA_EXCEEDED, RATE_LIMITED, CONCURRENCY_LIMIT, QUEUE_FULL,
  JOB_TIMEOUT, JOB_CANCELLED, SANDBOX_UNAVAILABLE, SANDBOX_TIMEOUT,
  EXTENSION_LOAD_FAILED, TEST_FAILED, WORKER_UNAVAILABLE,
  EMAIL_DELIVERY_FAILED, INTERNAL`). API errors are
  `{ error: { code, errorCode, message, referenceId, requestId } }` plus an
  `x-request-id` header; the message is always user-safe.
- `middleware.ts` generates/propagates `X-Request-ID` and the CSP nonce.
- `/api/health` and `/api/ready` (`lib/observability/readiness.ts`).

## Trust boundaries

```text
browser ──(cookies, CSRF origin check)──▶ web ──(SQLite, storage)──▶ worker ──(docker CLI)──▶ sandbox container
                                                                              ▲
                              extension code runs ONLY here ─────────────────┘
```

Uploaded code is never executed by web or worker; it is copied into a
disposable container as data. See `docs/SECURITY.md`.
