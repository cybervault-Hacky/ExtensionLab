# Architecture

ExtensionLab is a Next.js 15 / React 19 application with a Node.js worker,
SQLite (`node:sqlite`), a filesystem storage provider and Docker-isolated
browser sandboxes (Chromium, Microsoft Edge, Firefox — Phase 9). This
document describes the production architecture and how each phase composes
the previous ones without replacing them.

## Components

| Component | Location | Responsibility |
| --- | --- | --- |
| Web (Next.js) | `app/`, `components/`, `middleware.ts` | UI, REST/SSE API, auth, CSP, rate limits, enqueueing jobs |
| Worker | `scripts/worker.ts`, `lib/jobs/` | Claims jobs, runs automated tests in Docker, sends e-mail, cleanup |
| Analyzer (Phase 1/2) | `lib/extension/` | ZIP validation and static analysis — never executes code |
| Sandbox (Phase 3) | `lib/runtime/`, `sandbox/` | `SandboxManager` + Docker driver + in-container runner; per-browser adapters (Phase 9) |
| Browsers (Phase 9) | `lib/browsers/`, `sandbox/runner/browsers/` | Browser registry, capabilities, availability, matrix runs, comparison |
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

## Billing and entitlements (Phase 7)

```
request → session user → subscriptions row → resolveEffectivePlan()
        → entitlement check (canAnalyze / canRunTests / canCreateShare / …)
        → usage (reserve / record) → operation
```

- `lib/billing/entitlements.ts` is the only place that decides what a user
  may do. Product routes call `assertEntitled(canX(userId))` and receive the
  stable `429 QUOTA_EXCEEDED {currentUsage, limit, resetAt, requiredPlan}` /
  `402 PAYMENT_REQUIRED` / `413` errors from `lib/auth/api.ts`.
- The plan catalog (`lib/billing/plans.ts`) is configuration-driven and
  shared by the pricing page, the billing dashboard, `/api/me` and the checks.
- Subscription state is a projection of the payment provider: hosted checkout
  → signed webhook → `billing_events` ledger (idempotent) → `subscriptions`
  → effective plan. `checkout.session.completed` alone never activates; the
  return page polls `POST /api/billing/confirm`, which consults the provider
  about the caller's own session.
- Providers implement `BillingProvider` (`lib/billing/types.ts`); the Stripe
  adapter is a thin fetch client, the fake provider is in-memory and emits the
  same signed event shapes. Nothing outside `lib/billing/` knows which one is
  active.
- Usage periods: paid users are measured inside their billing period,
  everyone else per calendar month. Reservations from Phase 6 are unchanged.
- Loss of paid status (cancel, expiry, past-due after grace) switches the
  effective plan to Free without touching data; cleanup then applies Free
  retention.

Details: [BILLING.md](BILLING.md), [PLANS.md](PLANS.md).

## AI assistance (Phase 8)

```
POST /api/ai/* → session → AI rate limit → provider configured → canUseAI (plan)
              → owner-scoped source (report / run / snapshot)
              → buildContext (allowlist, redaction, byte budget, evidence index)
              → cache lookup → reserve ai_request quota → concurrency slot
              → prompt (rules + task + schema + <EXTENSIONLAB_DATA>) → AIProvider
              → strict JSON validation + evidence filtering + output redaction
              → consume reservation → ai_results → AIResponseEnvelope
```

- `lib/ai/service.ts` is the only code that calls a provider; routes are
  declarations (`createAIRoute({ feature, parse })`) and components are
  on-demand panels.
- AI is downstream of every deterministic system and upstream of none: it
  reads stored analysis/test/report data through the same `getOwned*`
  repositories as the private APIs, produces data (never actions), and its
  output is validated against the evidence it was given. Test suggestions
  are re-validated by the Phase 4 engine when a user chooses to run them.
- Providers implement `AIProvider` (`lib/ai/types.ts`): one OpenAI-compatible
  adapter and a deterministic fake for development and tests. Production
  configuration rejects the fake and defaults to `disabled`.
- Usage rides on the Phase 6/7 reservation table (`ai_request`), plan
  entitlements come from `canUseAI`, results live in `ai_results` with
  retention and cascade deletion.

Details: [AI.md](AI.md).

## Multi-browser testing (Phase 9)

```
POST /api/tests/matrix → auth/ownership/entitlement → availability probe
                       → atomic tx: browser_matrix_runs + one test_run/job/
                         quota reservation/execution per browser
                       → worker → automated-test handler
                         → SandboxManager.create({ browserId })
                         → per-browser pinned image + EXTENSIONLAB_BROWSER env
                         → BrowserRuntimeAdapter (CDP | geckodriver+BiDi)
                       → noteMatrixChildFinished (idempotent)
                       → all children terminal → finalizeMatrixRun
                         → deterministic CrossBrowserResult + report (once)
```

- One engine, three adapters: the Phase 4 test engine, evidence collection,
  scoring and diagnostics are unchanged and central; `sandbox/runner/browsers/`
  only adapts browser startup, extension loading and the automation protocol.
  Chromium and Edge share the CDP adapter (Edge = Chromium engine); Firefox
  has its own geckodriver/BiDi adapter and never fakes CDP.
- Capability gating is deterministic: assertions/actions requiring an
  `unsupported` capability are SKIPPED (`UNSUPPORTED`), never FAILED.
- Matrix statuses `queued → running → completed | partial | failed |
  cancelled`; `partial` is an honest aggregate when browsers disagree or one
  was unavailable. Infrastructure failures (`INFRASTRUCTURE_ERROR`) never
  masquerade as extension failures: the comparison reports insufficient data
  (coverage drop + `browsersUnavailable`) instead of a lower score.
- Quota policy: one test-run unit per browser execution (suite × 3 browsers =
  3 units), reserved atomically with the matrix rows; client quota values are
  never trusted.
- Comparison model: score = passing/executed browsers, coverage =
  executed/requested, evidence-based findings only (no root-cause claims),
  redacted network/console comparison, runtime errors grouped by normalized
  signature, side-by-side screenshots with no AI image interpretation.
- Baselines pin exact package version/snapshot/suite/browser config;
  regression comparison treats `FAIL → FAIL` as "ignored", never a new
  regression.

Details: [BROWSERS.md](BROWSERS.md).

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

Migration 003 (Phase 7):

```text
billing_customers(user_id→users, provider, provider_customer_id, created_at, updated_at)                      PK(user_id, provider), UNIQUE(provider, provider_customer_id)
subscriptions(id, user_id→users, provider, provider_customer_id, provider_subscription_id, provider_price_id, plan_id, status, current_period_start, current_period_end, cancel_at_period_end, cancel_at, canceled_at, trial_end, ended_at, last_event_at, created_at, updated_at)   UNIQUE(provider, provider_subscription_id)
billing_events(id, provider, provider_event_id, event_type, provider_event_type, user_id→users, subscription_id, result, created_at, processed_at)   UNIQUE(provider, provider_event_id)
checkout_sessions(id, user_id→users, provider, provider_session_id, plan_id, status, created_at, updated_at)   UNIQUE(provider, provider_session_id)
usage_events / quota_reservations: new (user_id, kind, created_at) indexes for period queries
```

Migration 005 (Phase 9):

```text
browser_matrix_runs(id, user_id→users, extension_id→extensions, package_id→extension_packages, test_suite_id, test_suite_name, status, browsers_json, compatibility_score, coverage, comparison_json, report_id→reports, reason, started_at, finished_at, created_at, updated_at)   index(user_id, created_at)
browser_matrix_executions(id, matrix_run_id→browser_matrix_runs, browser_id, test_run_id→test_runs, job_id→jobs, engine, status, outcome, error_code, reason, score, passed, failed, skipped, browser_version, evidence_json, started_at, finished_at, created_at, updated_at)   UNIQUE(matrix_run_id, browser_id), index(test_run_id)
test_baselines(id, user_id→users, extension_id→extensions, package_id→extension_packages, snapshot_id, test_suite_id, browsers_json, matrix_run_id, run_id, score, created_at, updated_at)   UNIQUE(user_id, extension_id)
regression_comparisons(id, user_id→users, extension_id→extensions, previous_json, current_json, browsers_json, comparison_json, regression_count, improvement_count, created_at)   index(user_id, created_at)
test_runs += browser_id, browser_version, engine, matrix_run_id
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

The optional AI provider (Phase 8) sits outside the boundary as an untrusted
HTTPS service: it receives redacted, allowlisted evidence and returns data
that is validated before use. It has no path back into the sandbox, the
database, the filesystem or the test engine.

## Phase 10 additions

- **Organizations** (`lib/organizations`): repository, entitlements, central
  authorization (roles → actions), service (lifecycle, members, invitations,
  billing hooks), exports. Personal workspaces are unchanged; org ownership
  is an optional column on existing resources.
- **Public API** (`app/api/v1`, `lib/api/v1-support`): API-key auth wrapper
  (scope → creator-role action → per-key/org/IP rate buckets) with the
  standard error envelope; `lib/idempotency` provides `Idempotency-Key`
  semantics scoped to the owner.
- **Webhooks** (`lib/webhooks`): signing (HMAC over `ts.eventId.body`),
  SSRF-validated destinations, dispatch (persisted deliveries + durable
  jobs), delivery worker with backoff/dead-letter, service CRUD.
- **Coordination** (`lib/coordination`): rate limiting and advisory locks
  behind a memory/Redis abstraction.
- **Policies** (`lib/policies`): deterministic, server-evaluated CI gates
  with evidence derived from stored runs/matrices/analyses.
- **Publications** (`lib/reports/publications`): safe public projection for
  published reports; `/extensions/:slug` pages default private.
- **SSO layer** (`lib/sso`): configuration + masked secrets + real DNS TXT
  domain verification; protocol exchange is a deployment-time adapter.
- **Queue**: `WEBHOOK_DELIVERY` and `ORG_EXPORT` job types; fairness-aware
  claiming; priority classes reorder but never bypass limits.

Uploaded code remains untrusted data executed only in disposable containers;
none of the new surfaces change that boundary.
