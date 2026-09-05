# Operations

Runbooks for operating ExtensionLab in production: the worker, cleanup,
monitoring, end-to-end verification and troubleshooting.

## Daily checks

```bash
curl -fsS https://lab.example.com/api/health
curl -fsS https://lab.example.com/api/ready | jq
```

A healthy deployment reports:

```json
{
  "status": "ok",
  "checks": {
    "database": { "status": "ok", "migrationsPending": 0 },
    "storage":  { "status": "ok", "provider": "local" },
    "worker":   { "status": "ok", "mode": "external", "live": 1, "activeJobs": 0 },
    "sandbox":  { "status": "ok", "available": true }
  },
  "capabilities": { "staticAnalysis": true, "automatedTests": true }
}
```

| Symptom in `/api/ready` | Meaning | Action |
| --- | --- | --- |
| `503`, `database.status = unavailable` | SQLite file unreadable / volume missing | Check the volume mount and permissions (uid 10001). |
| `migrationsPending > 0` | New release deployed without migrating | `npm run db:migrate` (or `RUN_MIGRATIONS=1`). |
| `storage.status = unavailable` | `STORAGE_PATH` not writable | Fix permissions; the health check writes and deletes a marker. |
| `worker.status = unavailable`, `live = 0` | No worker heartbeat in the last lease window | Start/restart the worker; check its logs for `config.problems`. |
| `sandbox.reason = docker_missing` | Docker CLI absent on the worker host | Install Docker or move the worker to a Docker-capable host. Static analysis keeps working. |
| `sandbox.reason = docker_unreachable` | Daemon down or socket not mounted | `docker info` as the worker user; check `DOCKER_GID`. |
| `sandbox.reason = image_missing` | `SANDBOX_IMAGE` not present | `npm run sandbox:build` (or pull the pinned tag). |
| `sandbox.reason = disabled` | `SANDBOX_DISABLED=true` | Intentional; automated tests are reported as unavailable. |

## Worker

```bash
npm run worker                                  # foreground; SIGTERM/SIGINT = graceful shutdown
WORKER_CONCURRENCY=2 SANDBOX_MAX_CONCURRENCY=2 npm run worker
```

- **Graceful shutdown**: the worker stops claiming, aborts and cancels active
  jobs (sandboxes are destroyed), waits up to `WORKER_SHUTDOWN_GRACE_MS`,
  reschedules anything still running (`retrying`, `WORKER_UNAVAILABLE`),
  removes its heartbeat row and closes the database. Give the process at
  least that long (`stop_grace_period: 45s` in compose).
- **Crash recovery**: if a worker dies (SIGKILL, OOM), its jobs keep a
  `lease_expires_at` in the past. The next worker start — or any live
  worker's sweep — re-queues them (attempts left) or fails them with
  `WORKER_UNAVAILABLE`; affected runs become `INFRASTRUCTURE_ERROR` and their
  quota reservation is released. Orphaned sandbox containers carry the label
  `extensionlab.sandbox=1`:

  ```bash
  docker ps -a --filter label=extensionlab.sandbox=1
  docker rm -f $(docker ps -aq --filter label=extensionlab.sandbox=1)   # after confirming no worker is active
  ```

- **Scaling**: one worker process per SQLite volume. Increase
  `WORKER_CONCURRENCY` (jobs) and `SANDBOX_MAX_CONCURRENCY` (containers) within
  the host's memory budget (~1 GB per sandbox with the default limits).
  `SANDBOX_USER_CONCURRENCY` keeps a single user from monopolising capacity.
- **Embedded mode** (`WORKER_MODE=embedded`) is for development or a single
  small box. It runs the same code inside the web process; Docker must then be
  reachable from the web process, which weakens the isolation described in
  `docs/SECURITY.md`.

## Jobs

Inspect the queue directly (read-only):

```bash
sqlite3 /data/extensionlab.sqlite "SELECT status, type, COUNT(*) FROM jobs GROUP BY 1,2;"
sqlite3 /data/extensionlab.sqlite "SELECT id, status, attempts, error_code, datetime(run_after/1000,'unixepoch') FROM jobs WHERE status='retrying';"
sqlite3 /data/extensionlab.sqlite "SELECT id, last_heartbeat_at, active_jobs, sandbox_available FROM workers;"
```

- Users see their own job through `GET /api/jobs/:id` (status, attempts,
  queue position, error code — never worker ids or payloads).
- To cancel a run on behalf of a user: `POST /api/tests/:runId/stop` as the
  owner, or `UPDATE jobs SET cancel_requested_at = strftime('%s','now')*1000
  WHERE id = 'job_…'` for a running job (the worker honours it within ~250 ms).
- Retry policy: only transient failures are retried, with backoff
  1 s, 2 s, 4 s, 8 s … (cap 60 s) up to `JOB_MAX_RETRIES`. Permanent failures
  (`INVALID_EXTENSION`, `FORBIDDEN`, `docker_missing`) fail immediately.

## Cleanup and retention

The scheduler enqueues `ARTIFACT_CLEANUP` every `CLEANUP_INTERVAL_MS`
(default 15 min). Each step is idempotent and logged as `cleanup.completed`
with counters:

| Step | What it removes | Setting |
| --- | --- | --- |
| Expired artifacts | screenshots/logs past `expires_at` (blob + row) | `ARTIFACT_RETENTION_DAYS` |
| Expired / orphaned packages | packages unused since the window (and not referenced by active runs) | `PACKAGE_RETENTION_DAYS` |
| Reconciliation | rows without blobs → `deleted`; blobs without rows (older than 10 min) removed; `deleting` rows finalized | — |
| Auth | expired reset tokens, expired sessions, expired/revoked shares | `RESET_TOKEN_RETENTION_DAYS`, `SESSION_RETENTION_DAYS`, `SHARE_RETENTION_DAYS` |
| Jobs | queued jobs never run → `expired`; finished jobs deleted; stale active runs → `INFRASTRUCTURE_ERROR`; dangling reservations released | `STALE_JOB_DAYS`, `JOB_RETENTION_DAYS`, `STALE_RUN_MINUTES` |
| Billing | open checkout sessions older than 24 h → `expired`; old checkout rows deleted; processed `billing_events` older than 90 days deleted (subscriptions are never deleted) | `JOB_RETENTION_DAYS` (checkout rows) |
| AI | stored AI results past `expires_at` (Phase 8) | `AI_RESULT_RETENTION_DAYS` |

Artifact and package retention are **per plan** since Phase 7
(`PLAN_<PLAN>_ARTIFACT_RETENTION_DAYS` / `PLAN_<PLAN>_PACKAGE_RETENTION_DAYS`);
the global `ARTIFACT_RETENTION_DAYS` / `PACKAGE_RETENTION_DAYS` values apply to
the Free plan. A downgraded user's data ages out under Free retention from the
next cleanup on.

Run it on demand on the worker host if needed (optionally scoped to
`artifacts`, `packages`, `auth`, `jobs`, `billing` or `ai`):

```bash
npm run cleanup
npm run cleanup -- artifacts
```

Cleanup never deletes Phase 5 rows before their retention window and never
touches data that is still referenced by an active run.

## Logs

All processes emit JSON lines to stdout/stderr:

```json
{"ts":"2026-09-05T10:41:59.123Z","level":"info","event":"job.completed","jobId":"job_…","userId":"usr_…","component":"worker","type":"AUTOMATED_TEST","durationMs":41873,"result":"completed"}
```

Useful events: `web.startup`, `worker.started`, `job.enqueued`,
`job.started`, `job.retry_scheduled`, `job.failed`, `job.cancelled`,
`worker.orphan_recovered`, `test_run.queued`, `test_run.finished`,
`test_run.artifacts`, `email.sent`, `email.failed`, `cleanup.completed`,
`metric.*`, `config.problems`. Correlate a user report by the
`Reference: req_…` id shown in the UI (`requestId` field / `x-request-id`
header). Secrets are redacted at the logger; do not add raw request bodies
to log calls.

## Rate limiting (single-replica caveat)

Limits are enforced in memory per web process. With one web replica they are
exact; with several, each replica keeps its own counters. Put an equivalent
limit on the reverse proxy (per IP for `/api/auth/*`, `/api/extensions`,
`/api/tests/create`, `/report/shared/*`) when scaling out, and make sure
`X-Forwarded-For` is set by a trusted proxy only.

## Backups

See `docs/DEPLOYMENT.md` → Backups. Use `sqlite3 .backup` for a consistent
snapshot while the services run, and back up `STORAGE_PATH` from the same
point in time.

## End-to-end verification with real Docker

Run this after building a new sandbox image or upgrading Docker:

```bash
npm run sandbox:build                              # or docker pull <pinned tag>
SANDBOX_IMAGE=extensionlab-sandbox:local npm run test:e2e
```

The suite (`tests/e2e/docker-runtime.e2e.test.ts`) uses the real worker,
`SandboxManager` and Docker driver:

1. `basic-extension` fixture (MV3, service worker, content script, popup,
   console events, one safe same-origin request) → run completes with real
   per-test results, the full stage sequence, runtime-log and network
   artifacts containing the fixture's console output, quota consumed once,
   temp directory removed, **no container left behind**.
2. `timeout-extension` fixture (busy-looping content script) → run never
   ends `PASSED`, container destroyed.
3. Cancellation of a running sandbox → `CANCELLED`, job `cancelled`,
   reservation released, container destroyed.
4. Invalid package → rejected before storage/Docker.
5. Worker crash simulation → orphan recovery + successful retry.
6. Live `docker inspect` of a sandbox: non-root, read-only rootfs,
   `CapDrop ALL`, `no-new-privileges`, no binds, PID/memory limits.

For cross-browser (Phase 9), build the per-browser images and run:

```bash
npm run sandbox:build:matrix
npm run test:e2e          # includes tests/e2e/cross-browser.e2e.test.ts
```

That suite runs a real matrix (one disposable container per browser, exact
browser versions recorded, deterministic comparison and report), verifies
fail-closed behavior when an image is missing, quota atomicity
(N browsers = N test-run units), the billing gate + clean cancellation, and
the regression A/B flow (v1.0.0 passes → v2.0.0 fails → PASS→FAIL reported,
`FAIL → FAIL` never invented). Without Docker both E2E suites skip with an
explicit reason; with `EXTENSIONLAB_E2E_DOCKER=1` a missing daemon or image
is a hard failure — browser results are never faked.

## Browser runtimes and matrices (Phase 9)

- `GET /api/browsers` shows per-runtime availability; the underlying probe
  checks Docker reachability and each pinned image (10 s cache). An
  unavailable runtime makes matrix creation fail with
  `BROWSER_RUNTIME_UNAVAILABLE` **before** anything is queued or charged.
- Stale matrices are finalized by the `matrix-sweep` cleanup job and a
  read-path sweep (grace `MATRIX_TIMEOUT_MS`): cancelled children, preserved
  results, one immutable cross-browser report per matrix.
- Metrics: `matrix.created`, `matrix.execution_finished`,
  `matrix.finalized`, `matrix.cancelled` (tags include browser ids and
  status). Log events carry `matrixRunId`, `browserId`, `browserVersion`.
- Quota policy is deterministic: **one test-run unit per browser execution**
  (suite × 3 browsers = 3 units). A rejected matrix reserves nothing.

Details: [BROWSERS.md](BROWSERS.md).

Without Docker the suite **skips with an explicit reason**; it never passes
by pretending. Set `EXTENSIONLAB_E2E_DOCKER=1` (as CI does) to turn a missing
Docker into a failure. `E2E_LOG_LEVEL=info` shows worker logs while debugging.

## Billing

Runbook material lives in [BILLING.md](BILLING.md); the short version:

- **Health:** `GET /api/billing/plans` is public and reports
  `billingEnabled` plus `purchasable` per plan — a quick check that price ids
  are configured. Webhook health is visible in the provider dashboard's
  delivery log and in `billing.webhook_*` metrics/log events.
- **Payment issues:** users in `past_due_grace` keep paid features for
  `BILLING_PAST_DUE_GRACE_DAYS`; the dashboard tells them to update the card
  in the portal. No operator action is needed unless the provider stops
  retrying.
- **Replays:** re-sending an event from the provider dashboard is always
  safe — the `billing_events` unique index makes it a `duplicate`.
- **Manual intervention:** there is intentionally no admin API to set a
  plan. Fix the subscription in the provider dashboard and let the webhook
  (or a replay) update the app.
- **Rotation:** rotate the webhook secret by adding a second endpoint,
  switching `BILLING_WEBHOOK_SECRET`, then removing the old endpoint. Rotate
  the API key by creating a new restricted key and restarting web + worker.
- **Disabling billing:** `BILLING_PROVIDER=disabled` keeps all users on Free
  and hides purchase actions; existing local subscriptions are ignored (not
  deleted), and account deletion proceeds with a warning.

## AI assistance (Phase 8)

Full reference in [AI.md](AI.md); operational summary:

- **Health:** `/api/ready` → `capabilities.aiAssistance` and `/api/me` →
  `ai.available` tell you whether a provider is configured. `ai.request`
  log events and `ai.*` metrics (tagged `feature`, `provider`, `result`)
  show volume, latency, token usage and the failure mix.
- **Provider incidents:** timeouts and 5xx from the provider surface to users
  as "AI analysis is temporarily unavailable." with a reference id; nothing
  else degrades. Raise `AI_TIMEOUT` or lower `AI_MAX_CONCURRENCY` if the
  provider throttles; set `AI_PROVIDER=disabled` to switch the feature off
  without a deploy of code.
- **Cost control:** `AI_MAX_CONTEXT_BYTES`, `AI_MAX_OUTPUT_TOKENS`,
  `RATE_LIMIT_AI_PER_MIN`, the plan allowances and result reuse
  (`AI_RESULT_RETENTION_DAYS`) bound spend; `ai.tokens_input` /
  `ai.tokens_output` metrics give the actual usage.
- **Key rotation:** replace `AI_API_KEY` and restart the web process. The key
  is never written anywhere else.
- **Data requests:** stored AI results are per user (`ai_results`), deleted
  by retention and by account deletion; prompts and raw responses are not
  stored, so there is nothing else to export or purge.

## Troubleshooting (browsers)

- `BROWSER_RUNTIME_UNAVAILABLE` on matrix creation → the pinned image is
  missing on that host: run `npm run sandbox:build:matrix` (or disable the
  runtime with `BROWSER_<ID>_ENABLED=0`).
- Matrix stuck in `running` → check the worker logs for `matrix.execution_finished`
  events; the sweep finalizes it after `MATRIX_TIMEOUT_MS`.
- A browser shows `skipped` with `INFRASTRUCTURE_ERROR` → infrastructure
  failure, not an extension failure: the compatibility score intentionally
  excludes it and reports insufficient data instead.

## Troubleshooting

| Problem | Likely cause | Fix |
| --- | --- | --- |
| Web returns 500 on every request in production | `ConfigError` at startup (check the first log line) | Set `APP_URL` (https), `SESSION_SECRET` (≥ 32), `EMAIL_PROVIDER`. |
| Runs stay `queued` forever | No worker, or worker cannot claim (`types` mismatch, DB locked) | Check `/api/ready` → `worker.live`; look for `worker.loop_error`. |
| Runs finish as `INFRASTRUCTURE_ERROR / SANDBOX_UNAVAILABLE` | Docker missing/unreachable or image missing on the worker host | See the readiness table above; runs are not charged to quota. |
| Runs finish as `TIMEOUT` | Extension blocks the page, or `SANDBOX_TIMEOUT` too low | Inspect the runtime-log artifact; raise `SANDBOX_TIMEOUT`/`JOB_TIMEOUT_MS` moderately. |
| `QUEUE_FULL` / `CONCURRENCY_LIMIT` for users | Back-pressure engaged | Add worker capacity or raise `JOB_MAX_QUEUE_LENGTH` / `JOB_MAX_QUEUED_PER_USER`. |
| `SQLITE_BUSY` in logs | Long transaction or many writers | Ensure a single worker per volume; `busy_timeout` is 5 s; check disk latency. |
| Password reset e-mails not arriving | `EMAIL_PROVIDER=noop`, or provider failures | `email.failed` events with `errorCode`; retries follow the backoff policy; the job payload is redacted after completion. |
| Orphaned containers | Worker killed without grace period | `docker rm -f` by label (above); sweeps also remove expired sandboxes. |
| Disk fills up | Retention too long or cleanup not running | Check `cleanup.completed` events; lower `*_RETENTION_DAYS`; verify the scheduler is started (`WORKER_MODE` not `disabled`). |
| Checkout return page never completes | Webhook rejected (`billing.webhook_rejected`) or unreachable endpoint | Verify `BILLING_WEBHOOK_SECRET` and that the proxy forwards the raw body; the confirm path also activates once the provider marks the session complete. |
| Users get `503 BILLING_NOT_CONFIGURED` | `BILLING_PROVIDER=disabled` or missing keys/price ids | See `docs/BILLING.md` → Configuration; startup logs list the offending variable. |
| `402 PAYMENT_REQUIRED` / `429 QUOTA_EXCEEDED` complaints from a paying user | Subscription not linked (`outcome: ignored` in webhook logs) | Check the `billing_customers` row for the user; replay the subscription event from the provider dashboard. |

## Release checklist

1. `npm run typecheck && npm run lint && npm run test && npm run build`
2. `npm run test:e2e` on a Docker-capable host (or the CI `docker-e2e` job)
2b. Billing: one test-mode checkout against the real provider on staging
    (checkout → webhook → dashboard shows the plan → cancel → reactivate)
3. Build and push `web`, `worker` and `sandbox` images with the same tag
4. Back up the database and storage
5. Migrate, roll web, then worker; verify `/api/ready`
6. Watch `job.failed` / `worker.orphan_recovered` for the first hour
