# ExtensionLab

> Test your browser extensions.

ExtensionLab is a premium browser-extension inspection and testing platform.
Phase 1 provides a polished web experience for uploading a browser extension
ZIP package and inspecting it locally in the browser. Phase 6 turned the
project into a production-deployable service: durable package storage, a
persistent background job queue and worker, real Docker execution, validated
configuration, e-mail delivery, structured logging, health/readiness probes,
artifact retention and hardened container images. Phase 7 makes it a
commercial SaaS: Free / Pro / Business plans, hosted checkout, provider
subscriptions, webhook-driven entitlements, per-period usage limits, billing
portal and invoices — with billing fully decoupled from the product. Phase 8
adds an optional, explainable AI assistance layer: on-demand explanations of
findings, test failures and runtime errors, report summaries, validated test
suggestions and scoped questions about a report — always labelled as AI
interpretation next to the deterministic, verified results. Phase 9 (current)
extends the same engine to a multi-browser platform: Chromium, Microsoft Edge
and Firefox run from per-browser pinned sandbox images through a small
runtime-adapter layer, with deterministic capability gating, browser matrix
runs, cross-browser comparison, baselines and regression detection.
See [Phase 6](#phase-6-production-infrastructure--commercial-readiness),
[Phase 7](#phase-7-plans-billing--entitlements),
[Phase 8](#phase-8-ai-assistance), [BROWSERS](docs/BROWSERS.md) and `docs/`.

**Phase 1 does not execute extensions.** It performs:

```text
UPLOAD → EXTRACT → INSPECT → ANALYZE → REPORT
```

Uploaded JavaScript, HTML and other files are treated as untrusted data. They
are never executed, installed, dynamically imported, or injected into the UI.

## Phase 1 scope

- Premium, minimal, responsive user interface
- Light and dark themes with a user-selectable accent colour
- ZIP upload with drag-and-drop and file picker support
- Client-side file validation and size limits
- Local package inspection using `JSZip`
- Manifest detection, including nested top-level folder packages
- Manifest version and standard-field analysis
- Permission and host-permission overview
- File structure browsing
- Basic configuration checks and missing referenced-file detection
- Transparent health score based on implemented checks
- Accessible, keyboard-friendly controls

Phase 1 intentionally does **not** include browser sandboxing, real extension
execution, network monitoring, live console capture, automated browser tests,
user accounts, payments, AI analysis, or cloud test history.

## Requirements

- Node.js 20 or newer (Node 22 is tested)
- npm 10 or newer

## Installation

```bash
npm install
```

## Development

```bash
npm run dev
```

Open the printed local URL. The preview environment binds to all interfaces
so the app can be reached through the hosted preview.

## Build

```bash
npm run build
```

The build fails on TypeScript errors, lint errors, test failures, or
production-build errors.

## Start production

The build uses Next.js `output: "standalone"`, so production runs the
generated server directly (not `next start`):

```bash
npm run build
npm run db:migrate
HOSTNAME=0.0.0.0 PORT=3000 node .next/standalone/server.js   # web
npm run worker                                              # background worker (separate process)
```

Production requires `APP_ENV=production`, an `https://` `APP_URL`, a
`SESSION_SECRET` of at least 32 characters and an explicit `EMAIL_PROVIDER`
(`http` or `noop`); startup fails closed otherwise. `npm run start` remains
available for local checks only. See `docs/DEPLOYMENT.md`.

## Lint

```bash
npm run lint
```

## Typecheck

```bash
npm run typecheck
```

## Test

```bash
npm run test        # unit + integration (no Docker required)
npm run test:e2e    # real-Docker end-to-end suite (skips itself when Docker is unavailable)
```

The end-to-end suite (`tests/e2e/`) runs the full pipeline against a real
sandbox container and skips with an explicit reason when Docker or the
sandbox image is missing. Set `EXTENSIONLAB_E2E_DOCKER=1` (CI does) to make an
unavailable Docker a hard failure instead of a skip. See `docs/OPERATIONS.md`.

The unit/integration suite covers the Phase 1–5 behaviour below plus, for
Phase 6: storage provider and package lifecycle, the job queue, worker,
retries, cancellation, orphan recovery, quota reservations, the test-run
pipeline with a fake sandbox, artifacts, e-mail delivery and password reset,
configuration validation, CSP, rate-limit policy, error catalog/logging
redaction, readiness, retention cleanup, account deletion and Docker
hardening flags; and, for Phase 7 (`tests/phase7/`): plan catalog and
environment overrides, the entitlement state machine (free / pro / trial /
expired / cancelled / past-due grace), checkout → signed webhook → Pro,
duplicate and tampered webhooks, cancel / reactivate / expiry, payment
failure and recovery, billing-period usage reset, invoice isolation, provider
failure handling, account deletion with an active subscription, the Stripe
adapter against a mocked API, product-API 429/402 contracts, the quota race,
plan-aware concurrency/priority, share gating and client-bundle hygiene; and,
for Phase 8 (`tests/phase8/`): the OpenAI-compatible adapter against a mocked
`fetch`, every fake-provider failure scenario through the real service,
redaction and prompt-injection fixtures asserted on the prompts the provider
mock received, context allowlisting/minimization, strict output validation
and evidence filtering, test-suggestion safety, plan/quota/ownership/share
rules on all six AI routes, retention, deletion and bundle hygiene. No test
calls a real AI provider; and, for Phase 9 (`tests/phase9/`): the browser
registry and capability model, entitlement- and quota-gated matrix creation
(atomic, one unit per browser), PARTIAL/infrastructure semantics, the
deterministic comparison and regression rules (`FAIL → FAIL` never counts),
static compatibility analysis, the browser/matrix/regression APIs with
ownership checks, per-browser container hardening and public-view
sanitization. The Docker E2E adds a real cross-browser matrix, regression
A/B and quota/billing flows (`tests/e2e/cross-browser.e2e.test.ts`).

Phase 1 coverage:

- Valid manifest V3
- Valid manifest V2 with informational compatibility warning
- Missing manifest
- Invalid manifest JSON
- Missing referenced service worker
- Permission detection
- Host-permission extraction and broad-access review
- Nested ZIP manifest detection
- Oversized-file rejection
- Unsupported-file rejection
- Corrupted ZIP graceful error

## Repository architecture

```text
app/
  page.tsx                 Landing page
  layout.tsx               Root layout and theme bootstrap
  globals.css              Design tokens
  dashboard/page.tsx       Extension analysis dashboard
components/
  layout/                  Navbar, Footer, Logo
  landing/                 Hero, HowItWorks, Features, UploadSection, CTA
  extension/               UploadZone, Workbench, dashboard cards
  settings/                Theme and accent selectors
  settings/ThemeProvider   Theme + accent context
  ui/                      Button, Card, Badge, Modal, Progress
lib/
  extension/analyzer.ts    ZIP processing and report orchestration
  extension/manifest.ts    Manifest parsing and feature detection
  extension/permissions.ts Permission analysis
  extension/validation.ts  File acceptance rules
  extension/limits.ts      Configurable safety limits
  theme/theme.ts           Theme and accent persistence
tests/                     Analyzer unit tests
types/extension.ts         Typed analysis result model
```

The analysis logic is independent from React. The UI calls the typed
analyzer and renders the result.

## Architecture flow

```text
UI
 ↓
analyzer.ts
 ↓
manifest parser
 ↓
permission analyzer
 ↓
file analyzer
 ↓
health scorer
 ↓
typed result
 ↓
UI
```

## Security considerations

- The extension ZIP is parsed **without executing any contained code.**
- Uploaded HTML is never rendered directly in the application.
- Uploaded file names are sanitized and displayed as text only.
- A 25 MB uploaded-file limit is enforced before reading.
- A maximum file count is enforced during extraction.
- A total uncompressed-size limit guards against zip bombs.
- A per-file uncompressed-size limit is enforced.
- `manifest.json` is limited to 512 KB before parsing.
- Malformed and corrupted ZIPs fail with a developer-friendly message rather
  than a raw stack trace.
- No secrets or API keys are required by Phase 1.

The limits are configurable constants in
`lib/extension/limits.ts`.

```ts
export const MAX_EXTENSION_SIZE = 25 * 1024 * 1024;
export const MAX_FILE_COUNT = 800;
export const MAX_TOTAL_UNCOMPRESSED_SIZE = 120 * 1024 * 1024;
export const MAX_SINGLE_FILE_SIZE = 25 * 1024 * 1024;
export const MAX_MANIFEST_SIZE = 512 * 1024;
```

## Database

Phase 5 uses a relational SQLite database for local development and the data
layer is designed so business logic can move to PostgreSQL later.

```bash
npm run db:migrate
```

The migration runner applies every SQL file in `lib/db/migrations/` in order.
The app also runs pending migrations lazily on first database access, so
`npm run dev` is sufficient for local work.

The database file defaults to `data/extensionlab.sqlite` and can be overridden
with `DATABASE_URL=sqlite:/path/to/file.sqlite` (Phase 6) or the legacy
`EXTENSIONLAB_DB_PATH` / `DATABASE_PATH` variables. `npm run db:migrate:status`
lists pending migrations without applying them. Migration
`002_phase6_infrastructure.sql` only adds tables and nullable columns; existing
Phase 5 rows are never modified or deleted.

## Deployment

Phase 5 is a server-rendered Next.js application and cannot run as a fully
static export because it requires cookies, server-side sessions, and a
persistent database.

```bash
npm run build
npm run db:migrate
node .next/standalone/server.js     # web (HOSTNAME/PORT from the environment)
npm run worker                      # worker, on a Docker-capable host
```

Deploy behind a TLS-terminating reverse proxy on a host that provides a
persistent writable volume for the SQLite database and package/artifact
storage. Automated tests additionally require a Docker-capable host for the
worker. `docker-compose.prod.yml` and the root `Dockerfile` (`web` and
`worker` targets) provide a reference deployment; `docs/DEPLOYMENT.md`
documents every environment variable, migrations, backups, health checks and
PostgreSQL notes.

## GitHub Actions

The CI definition is `ci.yml` (shipped at `.github/workflows-pending/ci.yml`
until a maintainer with workflow permissions moves it to
`.github/workflows/ci.yml` — see the README in that directory). On push and
pull requests it will:

1. Install dependencies from the lockfile
2. Run typecheck, lint, the unit/integration tests and the production build
3. Apply the migrations to a fresh database
4. Build the pinned sandbox image and run the real-Docker E2E suite
   (`EXTENSIONLAB_E2E_DOCKER=1`, so an unavailable Docker fails the job), then
   verify that no sandbox containers were left behind
5. Build the `web` and `worker` application images

## Roadmap

- **Phase 1 (implemented):** Premium UI, ZIP upload, local package inspection,
  manifest analysis, permission overview, file structure, configuration checks,
  health score.
- **Phase 2 (existing project):** Advanced manifest analysis, permission
  intelligence, reference resolution, and detailed findings are preserved.
- **Phase 3 (implemented):** Real browser extension execution inside an isolated
  Chromium container with runtime events, console/network capture, and cleanup.
- **Phase 4 (implemented):** Deterministic automated test engine, scores,
  diagnostics, and live SSE progress inside the sandbox.
- **Phase 5 (implemented):** Accounts, persistent extension projects, analysis
  snapshots, test history, immutable reports, comparison, secure sharing,
  usage limits, settings, and account deletion.
- **Phase 6 (implemented):** Production infrastructure — durable package storage,
  persistent job queue and worker, real Docker execution, configuration
  validation, e-mail delivery, structured logging, health/readiness, artifact
  retention, hardened images and a real-Docker E2E suite.
- **Phase 7 (implemented):** Plans, billing and entitlements — Free/Pro/Business
  catalog, provider-agnostic checkout and subscriptions, signed webhooks,
  server-side entitlement service, billing-period usage limits, portal,
  invoices, paywall UX and account-deletion cancellation.
- **Phase 8 (implemented):** AI assistance — provider abstraction with one
  OpenAI-compatible adapter and a deterministic fake, redacted and
  allowlisted evidence contexts, strict output validation with evidence
  links, validated test suggestions, plan-gated quotas and an on-demand UI
  that keeps AI interpretation visibly separate from verified results.
- **Phase 9 (current):** Multi-browser platform — Chromium/Edge/Firefox
  runtime adapters on per-browser pinned images with identical sandbox
  hardening, capability-aware test gating (unsupported → SKIPPED, never
  FAILED), browser matrix runs with honest PARTIAL semantics and
  infrastructure-vs-extension failure separation, deterministic
  cross-browser comparison with evidence-based findings, static
  manifest/API compatibility notes, baselines and regression comparison,
  browser-aware UI (selector, matrix run view, comparison table, regression
  page, history filters). See [docs/BROWSERS.md](docs/BROWSERS.md).
- **Later phases (planned):** Team collaboration and cloud managed history.

## Phase 4: Automated Testing & Runtime Diagnostics

Phase 4 adds a deterministic automated testing engine on top of the Phase 3
isolated sandbox.

```text
Static Analysis → Sandbox → Chromium → Predefined Test Actions → Runtime Evidence
→ Assertions → Deterministic Score → Diagnostics → Automated Report
```

### Test engine architecture

- `lib/testing/types.ts` — typed test, assertion, result, run, and diagnostic models
- `lib/testing/registry.ts` — deterministic built-in suites and static-analysis-driven discovery
- `lib/testing/assertions.ts` — deterministic assertion engine
- `lib/testing/selectors.ts` — safe selector policy
- `lib/testing/scoring.ts` — deterministic scoring
- `lib/testing/diagnostics.ts` — findings, JSON export, copy summary
- `lib/testing/test-runner.ts` — run lifecycle, cancellation, timeout, cleanup, real-time events
- `app/api/tests/*` — create/start/status/results/events/stream/stop endpoints

### Supported test actions

Only predefined browser actions are exposed. There is no arbitrary JavaScript,
no `eval`, no `executeScript`, no shell, and no raw CDP command endpoint.

`open_url`, `reload_page`, `wait`, `click`, `type`, `select`, `scroll`,
`inspect_text`, `inspect_element`, `open_popup`, `clear_console`,
`capture_screenshot`.

### Supported assertions

`element_exists`, `element_visible`, `text_contains`, `url_equals`,
`url_contains`, `console_contains`, `console_not_contains`,
`network_request_seen`, `network_status_equals`, `extension_loaded`,
`content_script_detected`, `service_worker_detected`, `popup_available`,
`runtime_error_none`, `network_4xx_none`, `network_5xx_none`.

### Built-in suites

- **Core Extension Suite** — extension loading, page loading, service worker,
  popup availability, console stability, and network behavior
- **Advanced Diagnostics Suite** — content scripts and broad permission review

Tests that are not applicable are skipped with an explicit reason. A skipped
test is never counted as a pass or a failure.

### Security model

- Preserves every Phase 3 boundary: fresh disposable container, no privileges,
  no Docker socket, no host mounts, no host network, no secrets, resource and
  event limits.
- Selector and URL values are validated; sensitive query parameters, cookies,
  and authorization headers remain redacted.
- Automated runs use their own per-session token and non-guessable `run_` IDs.
- Test commands can only be one of the predefined safe actions above.

### Scoring

- `passed = 100`, `warning = 50`, `failed/timeout/error = 0`, `skipped = excluded`.
- Scores are deterministic and documented in the generated report.
- Category scores only include applicable tests.

### Runtime requirements

Automated tests require Docker-capable infrastructure with the sandbox image:

```bash
docker build -f sandbox/Dockerfile -t extensionlab-sandbox:local .
```

The frontend can be hosted separately.

### Known limitations

- Some browser extension APIs are not observable through Chromium/CDP.
- Popup interaction may require browser-specific handling; the runner reports
  it as unavailable rather than faking a successful test.
- MV3 service workers are event-driven and may be transiently idle; idle state
  is not reported as an error.
- Source locations can only be reported when the runtime emits them.

## Phase 3: Isolated Browser Sandbox & Runtime Testing

Phase 3 adds real browser execution inside a fresh, disposable container.

```text
STATIC ANALYSIS → ISOLATED CHROMIUM → REAL EXTENSION EXECUTION → RUNTIME EVENTS → CLEANUP
```

The host application never executes extension code directly. Each test gets a
new non-privileged Docker container with:

- Non-root `node` user
- Dropped Linux capabilities (`--cap-drop ALL`)
- Read-only root filesystem with writable tmpfs
- `no-new-privileges`, `--init`, and a process-count limit
- Hard memory, CPU, runtime, file-count, and event limits
- No Docker socket, no host mounts, no host PID namespace, and no privileged mode
- Restricted network access with a configurable `none` mode for maximum isolation
- Short-lived control port published only to `127.0.0.1`

The uploaded package is copied into the sandbox, then Chromium is started with
`--load-extension` pointing at that package. The browser runs under `xvfb`
because extension rendering requires a non-headless window.

### Runtime workflow

1. Static analysis (Phase 1/2) completes.
2. The frontend uploads the package to `POST /api/sandbox/create`.
3. The API extracts the package into a private temporary directory.
4. `SandboxManager` creates a disposable container and starts the runner.
5. The runner starts Chromium and loads the unpacked extension.
6. The runner opens the default ExtensionLab test page or a validated public URL.
7. Runtime console, network, page, extension, and error events stream back.
8. The tester UI shows a live browser screenshot and runtime panels.
9. Stopping the sandbox terminates the browser, destroys the container, and
   deletes temporary extension and log data.

### Sandbox API

```text
POST  /api/sandbox/create                     create a session (multipart: file, testUrl)
GET   /api/sandbox/:id/status               sandbox state
POST  /api/sandbox/:id/start                start container + browser
POST  /api/sandbox/:id/stop                 stop + destroy
POST  /api/sandbox/:id/reload               reload the test page
POST  /api/sandbox/:id/extension/restart    restart extension session
POST  /api/sandbox/:id/console/clear        clear runtime console
POST  /api/sandbox/:id/open-url             open a validated public URL
GET   /api/sandbox/:id/events               runtime events
GET   /api/sandbox/:id/events/stream        SSE real-time event stream
GET   /api/sandbox/:id/network              network entries
GET   /api/sandbox/:id/screenshot           current live browser frame
```

Every request requires the per-session token from `POST /api/sandbox/create`.
Container IDs and temporary paths are never exposed to clients.

### Runtime tester UI

`/dashboard/test` provides:

- Browser viewport with live sandbox screenshots
- Console, Network, Extension, and Events tabs
- Reload, Restart Extension, Clear Console, and Stop Sandbox controls
- Real backend state only; no simulated runtime results

### Runtime security policy

- Public HTTPS URLs only by default (`http:` is opt-in).
- Loopback, link-local, private RFC1918, IPv6 private, and metadata ranges are blocked.
- DNS resolution is checked server-side before opening a URL.
- Sensitive query parameters, cookies, and authorization headers are redacted.
- Runtime events, logs, network data, extension source, and containers are temporary.
- On failure the API returns a sanitized `referenceId`; internal paths and stack
  traces are never returned.

### Phase 3 configuration (`.env.example`)

```ini
SANDBOX_IMAGE=extensionlab-sandbox:local
SANDBOX_MAX_RUNTIME=120
SANDBOX_MEMORY_LIMIT=768m
SANDBOX_CPU_LIMIT=0.5
SANDBOX_MAX_CONCURRENT=2
SANDBOX_MAX_PER_WINDOW=4
SANDBOX_RATE_LIMIT_WINDOW_MS=60000
SANDBOX_NETWORK_MODE=restricted
SANDBOX_MAX_EVENTS=500
SANDBOX_MAX_EVENT_SIZE=8192
SANDBOX_MAX_LOG_LENGTH=2000
SANDBOX_MAX_NETWORK_EVENTS=200
SANDBOX_ALLOW_HTTP=false
```

### Sandbox image

```bash
docker build -f sandbox/Dockerfile -t extensionlab-sandbox:local .
```

The container image is intentionally minimal: Node, Chromium, Xvfb, and font
packages. The runner source lives in `sandbox/runner/` and has its own
`package.json` and strict TypeScript build.

### Local development

Install Docker and Docker Compose, then:

```bash
cp .env.example .env.local
npm install
docker build -f sandbox/Dockerfile -t extensionlab-sandbox:local .
npm run dev
```

Launching a sandbox requires a Docker-capable host. GitHub Pages alone cannot
execute sandbox tests.

### Phase 3 automated tests

- `tests/runtime/urls.test.ts` — safe URL policy and DNS/network blocking rules
- `tests/runtime/redact.test.ts` — sensitive data redaction
- `tests/runtime/events.test.ts` — event and log limits
- `tests/runtime/sandbox-manager.test.ts` — state machine, capacity limits,
  rate limits, cleanup, and timeout behavior with a test driver

Docker integration tests are intentionally separated because they require a
container runtime. They should run in an environment with Docker installed and
the `extensionlab-sandbox:local` image built.

### Phase 3 test matrix

```text
Upload → Static Analysis → Sandbox Creation → Browser Start → Extension Load
→ Test Page → Runtime Events → Stop → Cleanup
```

Each stage is independently validated by the manager/runner architecture and
the unit tests above.


## Phase 5: Persistent Workspace, Accounts & Reports

Phase 5 turns ExtensionLab into a real SaaS workspace without rewriting the
analyzer, sandbox, or test engine.

```text
Account → Upload Extension → Static Analysis → Save Project → Run Tests
→ Persistent Test Result → Immutable Report → Compare → Share
```

### Authentication & sessions

- Email + password authentication with normalized, case-insensitive emails.
- Passwords are stored as salted `scrypt` hashes; passwords are never stored
  in plaintext.
- HttpOnly, SameSite=Lax server-side database sessions with random
  non-guessable token hashes.
- Secure cookie flag in production, session expiry, logout invalidation,
  logout-all-sessions, and origin checks for state-changing APIs.
- Generic sign-in and password-reset messages avoid account enumeration.
- Password reset tokens are random, hashed, expire after 30 minutes, and are
  single-use.

### Persistence & data model

- `users`, `sessions`, `password_resets`, `extensions`,
  `analysis_snapshots`, `test_runs`, `reports`, `shares`, `audit_events`, and
  `usage_events`.
- Every project, test run, report, and share is owned by a user. Ownership is
  enforced in every repository query; the frontend route is never used for
  authorization.
- Analysis snapshots are immutable. Reports reference a specific snapshot and
  test run and never rebuild from the latest extension state.
- Account deletion is transactional and removes owned projects, snapshots,
  test runs, reports, and share rows.

### Product features

- `/login`, `/signup`, `/forgot-password`, `/reset-password`
- `/dashboard`, `/dashboard/analyze`, `/dashboard/extensions[/id]`
- `/dashboard/tests[/runId]`, `/dashboard/reports[/id]`, `/dashboard/reports/compare`
- `/dashboard/settings`, `/dashboard/profile`
- `/report/shared/[token]` — public-safe summarized report only; never exposes
  email, credentials, sessions, private source, runtime secrets, host paths, or
  container internals.
- Usage limits are configuration-driven from the free plan
  (`PLAN_ANALYSIS_LIMIT`, `PLAN_TEST_LIMIT`, `PLAN_MAX_EXTENSION_SIZE`,
  `PLAN_MAX_CONCURRENT_RUNS`, `PLAN_HISTORY_RETENTION_DAYS`). Failed sandbox
  starts do not consume a test-run quota.

### Security notes

- Existing Phase 1-4 security boundaries are preserved. The user session is
  never passed into the sandbox.
- Redaction of authorization headers, cookies, passwords, tokens, secrets,
  api keys, and sensitive query parameters continues.
- Public reports render a safe projection with text rendering only.
- Share tokens are cryptographically random, revocable, and optionally
  expiring.

### Known limitations (as of Phase 5; addressed in Phase 6)

- Email delivery, permanent package storage and a Docker-backed E2E suite
  were out of scope for Phase 5. Phase 6 adds all three — see below.

## Phase 6: Production Infrastructure & Commercial Readiness

Phase 6 makes the platform deployable without rewriting the analyzer, sandbox,
test engine or workspace.

```text
Upload → Validate → Store package → Queue job → Worker → Docker sandbox
→ Chromium → Test engine → Results + artifacts → Persist → Report
```

### What changed

- **Storage abstraction** (`lib/storage/`): `put/get/delete/exists/stat/
  createReadStream/list` behind non-guessable keys
  (`extensions/<user>/<random>.zip`, `artifacts/<run>/<random>.png`). The
  local provider is the default; paths never reach clients. Uploads are
  validated (Phase 1/2 limits), written, read back and hash-verified before
  the `extension_packages` row is committed; failures clean the blob up.
- **Background jobs** (`lib/jobs/`): persistent `jobs` table with
  `queued → running → completed | failed | cancelled | expired` and
  `failed → retrying → running` for transient errors (exponential backoff
  1s, 2s, 4s, 8s … capped at 60s). Atomic claiming with leases, orphan
  recovery on startup and during sweeps, idempotency keys, cooperative
  cancellation, per-user and global concurrency, queue back-pressure and a
  graceful `SIGTERM`/`SIGINT` shutdown. Run it with `npm run worker`
  (`WORKER_MODE=external`) or embedded in the web process for development.
- **Real Docker execution**: the worker drives the Phase 3 `SandboxManager`
  and Docker driver unchanged (non-root, `--cap-drop ALL`,
  `no-new-privileges`, read-only rootfs, `noexec` tmpfs, memory/CPU/PID
  limits, loopback-only control port, no host network/mounts/socket).
  A pre-flight probe distinguishes "Docker missing", "daemon unreachable"
  and "image missing"; a run whose sandbox never started ends as
  `INFRASTRUCTURE_ERROR` with no fabricated score and no quota consumed.
- **Validated configuration** (`lib/config/env.ts`): every variable in
  `.env.example` is parsed once; production refuses to start without
  mandatory secrets or with unsafe settings.
- **E-mail** (`lib/email/`): `console | file | http | noop` providers behind
  one interface; password resets enqueue an `EMAIL` job inside the same
  transaction as the hashed token. Raw tokens are never logged and job
  payloads are redacted once delivered.
- **Observability**: JSON logs with `ts, level, event, requestId, jobId,
  userId, durationMs, result, errorCode` and automatic redaction of secrets;
  `X-Request-ID` correlation; a stable error catalog; `GET /api/health`
  (liveness) and `GET /api/ready` (database, storage, worker, sandbox and
  capability flags).
- **Artifacts & retention**: screenshots, runtime logs and network summaries
  are stored privately with SHA-256 and expiry; `/api/artifacts/:id` is
  owner-only. A scheduled `ARTIFACT_CLEANUP` job enforces
  `*_RETENTION_DAYS` for packages, artifacts, reset tokens, sessions, shares,
  finished jobs and stale runs.
- **Security**: nonce-based CSP without `unsafe-eval` in production,
  configurable per-action rate limits (`RATE_LIMIT_*_PER_MIN`), no exec/shell
  routes, no Docker details in responses, transactional account deletion.
- **Deployment**: root `Dockerfile` (`web` and `worker` targets, non-root,
  production dependencies only), `docker-compose.prod.yml`,
  `.github/workflows/ci.yml` (typecheck, lint, tests, build, migrations,
  image builds and the real-Docker E2E job).

### New commands

| Command | Purpose |
| --- | --- |
| `npm run worker` | Start a background worker (needs Docker for automated tests) |
| `npm run db:migrate` / `npm run db:migrate:status` | Apply / inspect migrations |
| `npm run cleanup` | Run retention cleanup on demand |
| `npm run test:e2e` | Real-Docker end-to-end suite |
| `npm run sandbox:build` | Build the pinned sandbox image (Chromium) |
| `npm run sandbox:build:chromium` / `:edge` / `:firefox` | Build a dedicated per-browser image |
| `npm run sandbox:build:matrix` | Build all three per-browser images |

### Documentation

- `docs/DEPLOYMENT.md` — environment variables, migrations, images, compose,
  health checks, backups, PostgreSQL notes.
- `docs/ARCHITECTURE.md` — request/job/sandbox flows and data model.
- `docs/SECURITY.md` — trust boundaries, container hardening, CSP, logging.
- `docs/OPERATIONS.md` — runbooks: worker, cleanup, E2E, troubleshooting.
- `docs/BROWSERS.md` — multi-browser platform: runtimes, capabilities,
  matrices, comparison, baselines and regression.
- `docs/INTERACTIVE_BROWSER.md` — Phase 11 interactive extension browser:
  lifecycle, exact package binding, security model, API, jobs and recovery.

## Phase 7: Plans, Billing & Entitlements

Phase 7 adds the commercial layer without changing how analysis, sandboxes or
tests work.

```text
Free → pricing page → hosted checkout → provider subscription → signed webhook
→ subscriptions table → entitlement service → product APIs (429 / 402 / 413)
```

### What changed

- **Plans** (`lib/billing/plans.ts`): exactly Free, Pro and Business.
  Limits are configuration-driven (`PLAN_<PLAN>_*`), prices are display
  values from `BILLING_*_AMOUNT` / `BILLING_CURRENCY`, the charge is defined by
  the provider price (`BILLING_<PLAN>_PRICE_ID`). Nothing is hardcoded as a
  final price. Details: `docs/PLANS.md`.
- **Entitlement service** (`lib/billing/entitlements.ts`): `canAnalyze`,
  `canRunTests`, `canUploadPackage`, `canCreateShare`,
  `canUseAdvancedDiagnostics`, `getMaxConcurrentRuns`, `hasPriorityExecution`,
  `getRetentionForUser`, `getQuotaUsage`. Every product route goes through it;
  the frontend never decides. Quota errors return
  `429 QUOTA_EXCEEDED {currentUsage, limit, resetAt, requiredPlan}`; plan
  gates return `402 PAYMENT_REQUIRED`; size gates `413`.
- **Provider abstraction** (`lib/billing/provider.ts`, `providers/`): a
  Stripe REST adapter (no SDK) and an in-memory fake for development/tests
  behind one `BillingProvider` interface; `BILLING_PROVIDER=disabled` keeps
  everyone on Free. The fake is rejected in production; production requires
  live keys and validates all billing configuration at startup.
- **Subscriptions** (`lib/db/migrations/003_phase7_billing.sql`):
  `billing_customers`, `subscriptions`, `billing_events` (unique provider
  event id → idempotent webhooks) and `checkout_sessions`. No card data, no
  raw payloads. Existing `usage_events` / `quota_reservations` are reused;
  paid users are measured inside their billing period, Free users per
  calendar month.
- **Flow**: `POST /api/billing/checkout {planId}` (server maps plan → price)
  → provider → `/dashboard/billing/return` polls `POST /api/billing/confirm`
  ("payment is being confirmed") → activation comes from provider
  subscription objects via `POST /api/billing/webhook` (signature over the
  raw body, 400 on missing/invalid/tampered/stale, 200 on duplicates, 5xx on
  transient failures so the provider retries). Cancel at period end,
  reactivate, hosted portal and provider invoice links are exposed under
  `/api/billing/*` (session + same-origin + rate limits).
- **Grace and downgrade**: failed renewals keep paid features for
  `BILLING_PAST_DUE_GRACE_DAYS`; cancellation, expiry or past-due after grace
  fall back to Free without deleting anything. Account deletion cancels the
  provider subscription first and refuses to proceed if that fails.
- **UI**: public `/pricing`, `/dashboard/billing` (plan, usage bars, billing
  cycle, payment status, plans, actions, invoices), Billing nav item, subtle
  plan badges, `PaywallNotice` with *View plans* wherever a limit is hit, and
  reference ids on billing errors. No payment data ever reaches client
  storage or URLs.

### Documentation

- `docs/BILLING.md` — architecture, data model, configuration, lifecycle,
  webhooks, local testing with the fake provider, production setup, tax /
  refunds, troubleshooting.
- `docs/PLANS.md` — plan catalog, entitlement API and HTTP contract.
- `docs/SECURITY.md`, `docs/DEPLOYMENT.md`, `docs/OPERATIONS.md`,
  `docs/ARCHITECTURE.md` — updated for Phase 7.

## Phase 8: AI Assistance

Phase 8 layers an assistant over the existing platform without changing how
analysis, sandboxes, tests, ownership or billing work.

- **Deterministic first.** Everything ExtensionLab *verifies* — scores,
  findings, permissions, test outcomes, diagnostics — is still produced by the
  analyzer, the sandbox and the test engine and carries a "Verified by
  ExtensionLab" badge. AI panels are additional, labelled "AI interpretation"
  or "AI-assisted", show a confidence level (high / medium / low) and the
  disclaimer *"AI-generated guidance is based on the available ExtensionLab
  evidence. Verify recommendations before applying changes."*
- **Features** (all on demand, never on page load): *Explain with AI* on
  findings and diagnostics, *Analyze failure* on failed tests, *Analyze
  runtime errors* on a run, *Generate AI summary*, *Suggest tests* and *Ask
  about this report* on the report page. Every answer links to real finding /
  test / file / event / report-section ids; references the model invents are
  discarded.
- **Safety.** Contexts contain only allowlisted, size-bounded, redacted
  evidence (no package contents, raw manifests, account or billing data).
  Untrusted extension/report text is confined to a delimited data block under
  fixed system rules; output must be a single JSON object matching a strict
  schema and is redacted again. Test suggestions are validated against the
  Phase 4 action/assertion/selector/URL allowlists and can only be run through
  the normal test API. The model has no tools and no execution path.
- **Access and limits.** `POST /api/ai/{finding,test-failure,runtime-error,
  report-summary,suggest-tests,report-question}` require a session, pass the
  same-origin check, load resources through the owner-scoped repositories,
  and never accept share tokens. Plans gate the feature (`canUseAI`: Free not
  included, Pro 100, Business 500 requests per period, configurable), quota is
  charged only for validated answers, and per-user rate limits, concurrency
  caps and body/context/output size limits bound cost and abuse.
- **Providers.** `AI_PROVIDER=openai` with `AI_API_KEY` (any OpenAI-compatible
  `AI_BASE_URL`), `fake` for development/tests (deterministic, offline,
  scripted failures), or `disabled` (production default) — the app runs
  unchanged and shows "AI assistance is currently unavailable.". Production
  rejects the fake provider and never falls back to it.
- **Data.** Validated results are stored per user for
  `AI_RESULT_RETENTION_DAYS` (reused as "Previously generated" for identical
  evidence, removed by cleanup and account deletion); prompts and raw
  responses are not stored; logs and metrics carry aggregate metadata only.

Documentation: `docs/AI.md` (architecture, provider abstraction,
configuration, features, context building, redaction, quotas, rate limits,
injection defense, fake provider, testing, production setup, privacy, failure
behaviour); `docs/SECURITY.md`, `docs/DEPLOYMENT.md`, `docs/PLANS.md`,
`docs/OPERATIONS.md` and `docs/ARCHITECTURE.md` are updated for Phase 8.

## Phase 10 — Enterprise, scale & public platform

Organizations with owner/admin/developer/viewer roles, invitations and seats;
immutable redacted audit trails; API keys with scopes and hashed storage; a
versioned public API (`/api/v1`) with idempotency and per-key/org/IP rate
limits; signed webhooks with SSRF protection and dead-letter retries;
deterministic CI quality gates; async organization data export; published
reports via a safe public projection; an SSO configuration layer with real
DNS domain verification; and a fairness-aware multi-worker queue with Redis
coordination. Personal workspaces and all Phase 1–9 behaviour are unchanged.

Documentation: `docs/ORGANIZATIONS.md`, `docs/API.md`, `docs/API_KEYS.md`,
`docs/WEBHOOKS.md`, `docs/ENTERPRISE.md`, `docs/SSO.md` (plus updates to
SECURITY, DEPLOYMENT, OPERATIONS, ARCHITECTURE and PLANS).

## Phase 11 — Interactive extension browser

Load your uploaded extension package — the exact bytes, hash-verified — into a
disposable isolated Chromium and drive it from the web workspace at
`/dashboard/browser/[sessionId]`: browser chrome (back/forward/reload/address
bar), typed pointer/keyboard/scroll input, the extension's real popup rendered
inside the container, and Console / Network / Extension / Events / Screenshots
panels over a live SSE stream. Sessions are hard-lifetime limited with idle
expiry and visible stop reasons; concurrency and per-period quotas reuse the
Phase 7 entitlements; start/stop/cleanup run as jobs on the Phase 6 queue
against the Phase 3/9 Docker runtime. The uploaded extension stays untrusted:
typed allowlisted input only (validated twice), navigation behind the Phase 3
SSRF guard, PNG frames instead of video, no CDP/shell/flags/Docker socket, and
every termination path removes the container and the extracted package.
Chromium is offered today; Edge and Firefox arrive with the supported runtime.

Documentation: `docs/INTERACTIVE_BROWSER.md` (plus updates to SECURITY,
DEPLOYMENT, OPERATIONS, ARCHITECTURE, PLANS and `.env.example`).

## License

Not yet specified. The repository is currently configured for private or
internal use.


## Test Automation Studio (Phase 15)

Build repeatable extension tests **without writing JavaScript, shell commands
or browser automation code** at `/dashboard/tests/studio`: compose Setup /
Actions / Assertions / Cleanup from the exact engine allowlist, get selector
assistance restricted to safe strategies, define typed bounded variables
(secrets deliberately not supported), and save versioned tests (v1, v2, …)
bound to the exact package SHA-256. Run them manually or from CI via
`POST /api/v1/tests/:testId/runs` using existing API keys — with immutable
run history, deterministic baselines/regression classification, suites with
explicit dependencies and stop/continue failure policy, honest CI exit codes
and real-browser execution only (never faked). Details:
[docs/TEST_AUTOMATION_STUDIO.md](docs/TEST_AUTOMATION_STUDIO.md) and
[docs/CI_CD.md](docs/CI_CD.md).

## Billing (Phase 14)

Self-serve subscriptions with Razorpay: pick a plan on `/pricing`, click
**Buy Now**, pay in Razorpay's secure checkout, and your plan activates
automatically — server-verified payment + webhook confirmation, no manual
approval. Cards never touch ExtensionLab; cancel any time (paid access runs
to the period end). Setup: [docs/RAZORPAY.md](docs/RAZORPAY.md).
