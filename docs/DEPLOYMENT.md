# Deployment

This guide covers running ExtensionLab in production: the web server, the
background worker, the database, package/artifact storage and the Docker
sandbox infrastructure.

## Topology

```text
                 ┌──────────────┐        ┌──────────────────────┐
 browser ──TLS──▶│ reverse proxy│──────▶ │ web (Next.js, :3000) │
                 └──────────────┘        │  - API + pages       │
                                         │  - enqueues jobs     │
                                         └─────────┬────────────┘
                                                   │ SQLite (shared volume)
                                         ┌─────────▼────────────┐
                                         │ worker (npm run worker)
                                         │  - claims jobs        │
                                         │  - Docker sandboxes   │──▶ docker daemon ──▶ sandbox containers
                                         │  - artifacts/e-mail   │
                                         └───────────────────────┘
```

- **web** serves the UI and API. It never talks to Docker and never needs the
  Docker socket.
- **worker** executes `AUTOMATED_TEST`, `EMAIL` and `ARTIFACT_CLEANUP` jobs.
  It must run on a Docker-capable host (or with access to a daemon) to run
  automated tests. Without Docker, static analysis keeps working and test
  runs end honestly as `INFRASTRUCTURE_ERROR` / `SANDBOX_UNAVAILABLE`.
- **database**: SQLite through `node:sqlite` on a persistent volume shared by
  web and worker (WAL mode, `busy_timeout` 5 s). See [PostgreSQL](#postgresql)
  for the migration path.
- **storage**: local filesystem provider (`STORAGE_PROVIDER=local`) rooted at
  `STORAGE_PATH`, shared by web (uploads, artifact downloads) and worker
  (reads packages, writes artifacts).

## Requirements

- Node.js 22 (the runtime uses the built-in `node:sqlite` module).
- Docker Engine 24+ on the worker host, with the sandbox image built:
  `docker build -f sandbox/Dockerfile -t extensionlab-sandbox:local .`
  (or `npm run sandbox:build`). Pin `SANDBOX_IMAGE` to the tag you built.
- A persistent volume for `DATABASE_URL` and `STORAGE_PATH`.
- A TLS-terminating reverse proxy in front of the web service. The app trusts
  `X-Forwarded-For` for rate limiting; only expose it behind a proxy you control.

## Environment variables

Copy `.env.example` to `.env` and fill in real values. **Never commit `.env`.**
Production (`APP_ENV=production`) validates the configuration at startup and
refuses to run when a mandatory value is missing or unsafe.

### Application

| Variable | Required (prod) | Default | Notes |
| --- | --- | --- | --- |
| `APP_ENV` | yes | `development` | `development` \| `production` \| `test` |
| `APP_URL` | yes | `http://localhost:3000` | Public origin; must be `https://` in production. Used in e-mails. |
| `SESSION_SECRET` | yes | — | ≥ 32 random characters. |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error` |

### Database

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `sqlite:./data/extensionlab.sqlite` | `sqlite:/abs/path.sqlite`. Legacy `EXTENSIONLAB_DB_PATH` / `DATABASE_PATH` still work. A `postgres://` URL is rejected by this build (see below). |

### Storage

| Variable | Default | Notes |
| --- | --- | --- |
| `STORAGE_PROVIDER` | `local` | Only `local` ships today; the interface is provider-agnostic. |
| `STORAGE_PATH` | `./data/storage` | Directory created with mode `0700`. Must be shared by web and worker. |

### Sandbox (Docker)

| Variable | Default | Notes |
| --- | --- | --- |
| `DOCKER_BIN` | `docker` | Docker CLI used by the worker. |
| `SANDBOX_IMAGE` | `extensionlab-sandbox:local` | Pinned sandbox image tag. |
| `SANDBOX_MAX_CONCURRENCY` | `4` | Global concurrent sandboxes per worker (legacy `SANDBOX_MAX_CONCURRENT`). |
| `SANDBOX_USER_CONCURRENCY` | `1` | Concurrent automated test jobs per user. |
| `SANDBOX_TIMEOUT` | `120` | Max sandbox lifetime in seconds (legacy `SANDBOX_MAX_RUNTIME`). |
| `SANDBOX_MEMORY_LIMIT` / `SANDBOX_CPU_LIMIT` | `768m` / `0.5` | Container limits. |
| `SANDBOX_NETWORK_MODE` | `restricted` | `restricted` (bridge + SSRF policy) or `none`. |
| `SANDBOX_ALLOW_HTTP` | `false` | Keep `false` unless you run an egress proxy. |
| `SANDBOX_DISABLED` | `false` | Set `true` on hosts that intentionally have no Docker. |
| `SANDBOX_TEMP_ROOT` | `/tmp/extensionlab-runtime` | Where packages are staged before `docker cp`. |
| `SANDBOX_MAX_EVENTS`, `SANDBOX_MAX_EVENT_SIZE`, `SANDBOX_MAX_LOG_LENGTH`, `SANDBOX_MAX_NETWORK_EVENTS` | see `.env.example` | Event caps (Phase 3). |

### Jobs / worker

| Variable | Default | Notes |
| --- | --- | --- |
| `WORKER_MODE` | `embedded` (dev) / `external` (prod) | `embedded`: web process runs a worker loop; `external`: run `npm run worker`; `disabled`: no worker. |
| `WORKER_ID` | `<hostname>-<pid>` | Stable id for heartbeats/leases. |
| `WORKER_CONCURRENCY` | `4` | Jobs processed concurrently by one worker. |
| `WORKER_POLL_INTERVAL_MS` | `1000` | Poll interval when idle. |
| `WORKER_LEASE_MS` | `15000` | Lease renewed by heartbeats; expired leases are recovered by any worker. |
| `WORKER_SHUTDOWN_GRACE_MS` | `20000` | Time given to in-flight jobs on `SIGTERM`. |
| `JOB_MAX_RETRIES` | `3` | Retries for transient failures (attempts = retries + 1). |
| `JOB_TIMEOUT_MS` | `SANDBOX_TIMEOUT*1000 + 90000` | Hard per-job timeout (→ `JOB_TIMEOUT`). |
| `JOB_MAX_QUEUED_PER_USER` | `3` | Back-pressure per user. |
| `JOB_MAX_QUEUE_LENGTH` | `200` | Global back-pressure (→ `QUEUE_FULL`). |
| `CLEANUP_INTERVAL_MS` | `900000` | Scheduler interval for `ARTIFACT_CLEANUP`. |

### E-mail

| Variable | Default | Notes |
| --- | --- | --- |
| `EMAIL_PROVIDER` | `console` (dev) — **must be set in prod** | `console` \| `file` \| `http` \| `noop`. Production allows `http` or `noop` only. |
| `EMAIL_FROM` | `ExtensionLab <no-reply@localhost>` | Sender. |
| `EMAIL_FILE_DIR` | — | Required for `file`; messages are written as JSON (dev/E2E). |
| `EMAIL_HTTP_URL` / `EMAIL_HTTP_TOKEN` | — | Required for `http`: a JSON `POST {from,to,subject,text,html}` with `Authorization: Bearer <token>`; must be `https://` in production. |
| `EXTENSIONLAB_RESET_DEV_DIR` | — | Development-only reset-token drop directory. Rejected in production. |

### Rate limits (requests per minute per client)

`RATE_LIMIT_LOGIN_PER_MIN` (30), `RATE_LIMIT_SIGNUP_PER_MIN` (30),
`RATE_LIMIT_FORGOT_PASSWORD_PER_MIN` (10), `RATE_LIMIT_RESET_PASSWORD_PER_MIN`
(20), `RATE_LIMIT_UPLOAD_PER_MIN` (30), `RATE_LIMIT_TEST_CREATE_PER_MIN` (20),
`RATE_LIMIT_SANDBOX_CREATE_PER_MIN` (10), `RATE_LIMIT_SHARE_CREATE_PER_MIN`
(20), `RATE_LIMIT_PUBLIC_REPORT_PER_MIN` (60), `RATE_LIMIT_REPORT_CREATE_PER_MIN`
(30). The store is in-memory per web process — see the single-replica note
in `docs/OPERATIONS.md`.

### Retention

`PACKAGE_RETENTION_DAYS` (30), `ARTIFACT_RETENTION_DAYS` (14),
`RESET_TOKEN_RETENTION_DAYS` (1), `SESSION_RETENTION_DAYS` (7),
`JOB_RETENTION_DAYS` (14), `SHARE_RETENTION_DAYS` (30), `STALE_JOB_DAYS` (1),
`STALE_RUN_MINUTES` (30).

### Plan limits

`PLAN_<FREE|PRO|BUSINESS>_<ANALYSIS_LIMIT|TEST_LIMIT|MAX_EXTENSION_SIZE|
MAX_CONCURRENT_RUNS|HISTORY_RETENTION_DAYS|ARTIFACT_RETENTION_DAYS|
PACKAGE_RETENTION_DAYS>`. The Phase 5 names (`PLAN_ANALYSIS_LIMIT`,
`PLAN_TEST_LIMIT`, `PLAN_MAX_EXTENSION_SIZE`, `PLAN_MAX_CONCURRENT_RUNS`,
`PLAN_HISTORY_RETENTION_DAYS`) still configure the Free plan. Defaults and
semantics: [PLANS.md](PLANS.md).

### Billing (Phase 7)

| Variable | Notes |
| --- | --- |
| `BILLING_PROVIDER` | `stripe`, `fake` (dev/test only, rejected in production) or `disabled` (default in production: everyone on Free, no purchase UI) |
| `BILLING_SECRET_KEY` | provider secret/restricted key; production requires a live key |
| `BILLING_WEBHOOK_SECRET` | signing secret of the `/api/billing/webhook` endpoint |
| `BILLING_PRO_PRICE_ID`, `BILLING_BUSINESS_PRICE_ID` | provider price ids; a plan without one is not purchasable |
| `BILLING_CURRENCY`, `BILLING_PRO_AMOUNT`, `BILLING_BUSINESS_AMOUNT` | display only (minor units); the provider price is what is charged |
| `BILLING_PAST_DUE_GRACE_DAYS` | paid access kept after a failed renewal (7) |
| `BILLING_DELETION_POLICY` | `cancel_immediately` (default) or `cancel_at_period_end` on account deletion |
| `RATE_LIMIT_BILLING_{READ,CHECKOUT,PORTAL,CHANGE,WEBHOOK}_PER_MIN` | 60 / 5 / 5 / 10 / 600 |

`APP_URL` must be the public origin: checkout success/cancel and portal
return URLs are built from it. The webhook endpoint must receive the raw
request body (no JSON re-serialisation by a proxy). Full setup, lifecycle and
troubleshooting: [BILLING.md](BILLING.md).

## Build and run without containers

```bash
npm ci
npm run build                     # Next.js standalone output in .next/standalone
npm run db:migrate                # explicit migrations (idempotent)

# web
APP_ENV=production APP_URL=https://lab.example.com SESSION_SECRET=... \
EMAIL_PROVIDER=noop DATABASE_URL=sqlite:/srv/extensionlab/db.sqlite \
STORAGE_PATH=/srv/extensionlab/storage WORKER_MODE=external \
HOSTNAME=0.0.0.0 PORT=3000 node .next/standalone/server.js

# worker (same env, Docker-capable host)
npm run worker
```

Use `node .next/standalone/server.js`, not `next start`: the standalone
server embeds only the production dependencies it needs and honours
`HOSTNAME`/`PORT`. The `instrumentation.ts` hook validates configuration at
boot; in production a `ConfigError` aborts startup with the list of problems
(never the values).

## Containers

The root `Dockerfile` has two runtime targets:

| Target | Runs | User | Contains Docker CLI | Notes |
| --- | --- | --- | --- | --- |
| `web` | `node server.js` (standalone) | `extensionlab` (uid 10001) | no | `HEALTHCHECK` on `/api/health`; `RUN_MIGRATIONS=1` applies migrations at start. |
| `worker` | `npm run worker` | `extensionlab` (uid 10001, in the Docker group) | yes | Needs `/var/run/docker.sock` mounted; build arg `DOCKER_GID` must match the host socket gid. |

```bash
docker build --target web    -t extensionlab-web:1.0.0 .
docker build --target worker -t extensionlab-worker:1.0.0 --build-arg DOCKER_GID=$(stat -c %g /var/run/docker.sock) .
docker build -f sandbox/Dockerfile -t extensionlab-sandbox:1.0.0 .
```

Never mount the Docker socket into the `web` container, and never expose the
Docker daemon over TCP without mutual TLS.

### docker-compose.prod.yml

```bash
cp .env.example .env    # fill in APP_URL, SESSION_SECRET, EMAIL_PROVIDER, DOCKER_GID …
docker compose -f docker-compose.prod.yml --profile run-once build sandbox-image
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml run --rm web node scripts/db-migrate.mjs
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
curl -fsS http://127.0.0.1:3000/api/ready | jq
```

The compose file publishes the web port on `127.0.0.1:3000` only; terminate
TLS with your proxy. The `data` volume holds the database and storage. Run
exactly one worker replica per volume (SQLite) — scale sandbox throughput
with `SANDBOX_MAX_CONCURRENCY` / `WORKER_CONCURRENCY` instead.

## Migrations

- `npm run db:migrate` applies pending files from `lib/db/migrations/` in
  lexical order, each inside a transaction, and records them in
  `schema_migrations`.
- `npm run db:migrate:status` lists applied and pending migrations.
- Migrations are additive: `002_phase6_infrastructure.sql` creates
  `extension_packages`, `jobs`, `job_events`, `workers`, `quota_reservations`,
  `artifacts` and adds nullable columns to `test_runs` /
  `analysis_snapshots`; `003_phase7_billing.sql` creates `billing_customers`,
  `subscriptions`, `billing_events`, `checkout_sessions` and period indexes on
  `usage_events` / `quota_reservations`. Phase 5 data is never modified or
  deleted.
- The web process also applies pending migrations lazily on first database
  access, so a forgotten explicit migration degrades gracefully; `/api/ready`
  reports `migrationsPending` so you can catch it.
- Roll forward only. Take a backup before migrating.

## Health checks

| Endpoint | Purpose | 200 when |
| --- | --- | --- |
| `GET /api/health` | Liveness | process serves requests |
| `GET /api/ready` | Readiness | database and storage are usable (`503` otherwise). `status` is `degraded` when the worker or sandbox is unavailable; `capabilities.automatedTests` tells you whether test runs can execute. |

`/api/ready` never includes hostnames, socket paths, container ids or
versions — only stable status/reason codes (`docker_missing`,
`docker_unreachable`, `image_missing`, `disabled`, `worker_unavailable`).

## Backups

- **Database**: with WAL enabled, copy consistently using
  `sqlite3 /data/extensionlab.sqlite ".backup '/backups/extensionlab-$(date +%F).sqlite'"`
  (or stop the services and copy the file plus `-wal`/`-shm`).
- **Storage**: back up `STORAGE_PATH` (packages + artifacts). Keys are stored
  in the database, so restore both from the same point in time. The cleanup
  job reconciles rows without blobs (`status = deleted`) and removes blobs
  without rows after a grace period.
- Test a restore periodically: start a throw-away stack with the restored
  volume and check `/api/ready` and a stored report.

## PostgreSQL

This build ships the SQLite driver only. The repository layer keeps SQL
portable (parameterised statements, `INTEGER` epoch timestamps, no SQLite
specific functions beyond `RETURNING`), and job claiming uses a conditional
`UPDATE … RETURNING` that maps directly onto
`UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED) RETURNING *` in
PostgreSQL. Moving to PostgreSQL requires:

1. A PostgreSQL client in `lib/db/client.ts` (the only place that opens a
   connection) plus `transaction()` semantics (`BEGIN`/`COMMIT`).
2. Type adjustments in the migrations (`INTEGER PRIMARY KEY AUTOINCREMENT` →
   `BIGSERIAL`, `TEXT` booleans → `BOOLEAN`).
3. Running the migration runner against the new database and copying data
   with a one-off script.

Until then, `DATABASE_URL=postgres://…` is rejected at startup with a clear
message so nobody deploys against an unsupported backend by accident.

## Upgrading

1. Back up the database and storage.
2. Deploy the new images/build.
3. Run `npm run db:migrate` (or `RUN_MIGRATIONS=1` on the web container).
4. Restart `web`, then `worker`. Workers shut down gracefully: they stop
   claiming, wait up to `WORKER_SHUTDOWN_GRACE_MS` for active runs, destroy
   sandboxes and reschedule anything left; the next worker recovers expired
   leases automatically.
5. Verify `/api/ready` reports `worker.live ≥ 1` and `sandbox.available: true`.
