# Environment Variables

This document is the deployment inventory for the current codebase. Keep real values exclusively in the hosting provider's encrypted environment-variable store or a secret manager. `.env`, `.env.production`, database files, API keys, payment secrets, storage credentials, and private tokens are ignored by Git and must never be committed.

## Visibility rules

- **Server-only** is the default for every variable listed here. Do not create `NEXT_PUBLIC_*` aliases for a secret.
- **Public by design** applies only to a Razorpay checkout key ID, which the provider requires in the browser. It is still configured server-side as `RAZORPAY_KEY_ID`; no `NEXT_PUBLIC_*` value is needed.
- A value marked **secret** must be encrypted at rest in the provider and excluded from logs, browser bundles, issue comments, and deployment documentation.
- `APP_ENV=production` fails closed for an absent/short `SESSION_SECRET`, unsafe e-mail configuration, fake billing, fake AI, or incomplete selected payment configuration.

## Controlled public preview values

For the Vercel preview described in `PUBLIC_PREVIEW_DEPLOYMENT.md`, set only the following application configuration. `SESSION_SECRET` is secret; the remaining values are non-secret controls.

| Variable | Required | Service | Purpose |
| --- | --- | --- | --- |
| `APP_ENV=production` | yes | web | Enables production validation. |
| `APP_URL=https://…vercel.app` | yes | web | Canonical public origin. HTTPS only. |
| `SESSION_SECRET` | yes, secret | web | At least 32 random characters; required even while account routes are blocked. |
| `EMAIL_PROVIDER=noop` | yes | web | Disables password e-mail delivery honestly. |
| `BILLING_PROVIDER=disabled` | yes | web | Prevents checkout and webhooks. |
| `AI_PROVIDER=disabled` | yes | web | Prevents AI requests. |
| `WORKER_MODE=disabled` | yes | web | Prevents an embedded worker from starting. |
| `SANDBOX_DISABLED=true` | yes | web | Declares Docker browser execution unavailable. |
| `EXTENSIONLAB_PREVIEW_MODE=controlled` | yes | middleware/web | Blocks all stateful and infrastructure-dependent routes. |
| `LOG_LEVEL=info` | recommended | web | Redacted operational logging. |

Do not set a database, Redis, S3, Docker, Razorpay, or AI credential on this preview. Middleware blocks affected routes before they can fall back to a local or in-memory service.

## Application and persistence

| Variables | Required in a full current deployment | Service | Notes |
| --- | --- | --- | --- |
| `APP_ENV`, `APP_URL`, `SESSION_SECRET`, `LOG_LEVEL` | `APP_ENV`, `APP_URL`, `SESSION_SECRET`; `LOG_LEVEL` optional | web/worker | `APP_URL` must be HTTPS in production. `SESSION_SECRET` is secret. |
| `EXTENSIONLAB_PREVIEW_MODE` | no | middleware/web | Set to exactly `controlled` only for the restricted public preview. Omit for a full deployment. |
| `DATABASE_URL` | yes for a stateful deployment | web/worker/migration | Current implementation accepts `sqlite:<path>` and uses `node:sqlite`. It rejects `postgres://` / `postgresql://`; PostgreSQL is not currently deployable. Never use `:memory:` in production. |
| `EXTENSIONLAB_DB_PATH`, `DATABASE_PATH` | legacy alternatives | web/worker/migration | Used only when `DATABASE_URL` is absent. Server-only paths; persistent volume required. |
| `STORAGE_PROVIDER`, `STORAGE_PATH` | yes for package/artifact persistence | web/worker | `local` is the current default and requires a shared, private persistent volume. It is not suitable for Vercel. |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_PREFIX`, `S3_FORCE_PATH_STYLE` | only for `STORAGE_PROVIDER=s3` | web/worker | Server-only. Current image lacks `@aws-sdk/client-s3`, so selecting S3 fails closed until that dependency is deliberately supplied and tested. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | only for S3 | web/worker | **Secrets.** Never public. Bucket must be private; test upload, download, SHA-256 verification, retention, and cleanup before enabling. |

## Worker, sandbox, and browser runtime

| Variables | Required | Service | Notes |
| --- | --- | --- | --- |
| `WORKER_MODE`, `WORKER_ID`, `WORKER_CONCURRENCY`, `WORKER_POLL_INTERVAL_MS`, `WORKER_LEASE_MS`, `WORKER_SHUTDOWN_GRACE_MS`, `JOB_MAX_RETRIES`, `JOB_TIMEOUT_MS`, `JOB_MAX_QUEUED_PER_USER`, `JOB_MAX_QUEUE_LENGTH`, `CLEANUP_INTERVAL_MS` | full worker only | worker | `WORKER_MODE` is `embedded`, `external`, or `disabled`. Use `external` for an actual dedicated worker. |
| `SANDBOX_DISABLED`, `SANDBOX_IMAGE`, `SANDBOX_MAX_CONCURRENCY`, `SANDBOX_MAX_CONCURRENT`, `SANDBOX_USER_CONCURRENCY`, `SANDBOX_TIMEOUT`, `SANDBOX_MAX_RUNTIME` | browser execution only | worker | `SANDBOX_DISABLED=true` is the explicit preview kill switch. |
| `DOCKER_BIN`, `SANDBOX_TEMP_ROOT`, `SANDBOX_MEMORY_LIMIT`, `SANDBOX_CPU_LIMIT`, `SANDBOX_NETWORK_MODE`, `SANDBOX_ALLOW_HTTP`, `SANDBOX_MAX_EVENTS`, `SANDBOX_MAX_EVENT_SIZE`, `SANDBOX_MAX_LOG_LENGTH`, `SANDBOX_MAX_NETWORK_EVENTS`, `SANDBOX_MAX_NETWORK_URL_LENGTH`, `SANDBOX_MAX_URL_LENGTH`, `SANDBOX_MAX_PER_WINDOW`, `SANDBOX_RATE_LIMIT_WINDOW_MS`, `SANDBOX_RUNNER_CONTROL_PORT`, `SANDBOX_RUNNER_HEALTH_TIMEOUT_MS`, `SANDBOX_CONTAINER_START_TIMEOUT_MS`, `SANDBOX_CLEANUP_GRACE_MS`, `SANDBOX_ORPHAN_CHECK_MS`, `SANDBOX_TTL_MS` | tuned full worker only | worker/sandbox | Keep network restricted or none, no Docker socket in web containers, and run workers on a dedicated trust boundary. |
| `SANDBOX_IMAGE_CHROMIUM`, `SANDBOX_IMAGE_EDGE`, `SANDBOX_IMAGE_FIREFOX`, `BROWSER_CHROMIUM_VERSION`, `BROWSER_EDGE_VERSION`, `BROWSER_FIREFOX_VERSION`, `BROWSER_<ID>_EXECUTABLE`, `BROWSER_<ID>_ENABLED` | browser matrix only | worker | Pin images and record versions. An absent image reports unavailable; it must not be presented as a passing test. |
| `MAX_BROWSERS_PER_MATRIX`, `MAX_MATRIX_TESTS`, `MAX_MATRIX_CONCURRENCY`, `MAX_MATRIX_ARTIFACTS`, `MATRIX_TIMEOUT_MS`, `MATRIX_BROWSER_TIMEOUT_MS` | browser matrix only | worker | Capacity controls. |
| `INTERACTIVE_BROWSER_ENABLED`, `INTERACTIVE_BROWSER_MAX_GLOBAL`, `INTERACTIVE_BROWSER_MAX_PER_ORG`, `INTERACTIVE_BROWSER_MAX_MINUTES`, `INTERACTIVE_BROWSER_IDLE_TIMEOUT_MS`, `INTERACTIVE_BROWSER_IDLE_GRACE_MS`, `INTERACTIVE_BROWSER_FRAME_INTERVAL_MS`, `INTERACTIVE_BROWSER_MAX_FRAME_BYTES`, `INTERACTIVE_BROWSER_MAX_ARTIFACTS`, `INTERACTIVE_BROWSER_MAX_EVIDENCE`, `INTERACTIVE_BROWSER_INPUT_PER_MIN`, `INTERACTIVE_BROWSER_KEEPALIVE_PER_MIN`, `INTERACTIVE_BROWSER_VIEWPORT_MIN_WIDTH`, `INTERACTIVE_BROWSER_VIEWPORT_MAX_WIDTH`, `INTERACTIVE_BROWSER_VIEWPORT_MIN_HEIGHT`, `INTERACTIVE_BROWSER_VIEWPORT_MAX_HEIGHT`, `INTERACTIVE_BROWSER_CONSOLE_RING`, `INTERACTIVE_BROWSER_NETWORK_RING`, `INTERACTIVE_BROWSER_EVENT_RING` | interactive browser only | worker | Do not enable before live isolated-runtime verification. |

## Coordination, e-mail, retention, and rate controls

| Variables | Required | Service | Notes |
| --- | --- | --- | --- |
| `COORDINATION_PROVIDER`, `REDIS_URL` | only for Redis coordination | web/worker | `memory` is process-local. `redis` requires the absent `redis` package plus a secured service; it fails closed in production until initialized. `REDIS_URL` is secret. |
| `EMAIL_PROVIDER`, `EMAIL_FROM`, `EMAIL_HTTP_URL`, `EMAIL_HTTP_TOKEN`, `EMAIL_FILE_DIR`, `EXTENSIONLAB_RESET_DEV_DIR` | e-mail provider dependent | web/worker | Production allows `http` or `noop` only. `EMAIL_HTTP_TOKEN` is secret; HTTP e-mail endpoint must be HTTPS. `EXTENSIONLAB_RESET_DEV_DIR` is prohibited in production. |
| `PACKAGE_RETENTION_DAYS`, `ARTIFACT_RETENTION_DAYS`, `RESET_TOKEN_RETENTION_DAYS`, `SESSION_RETENTION_DAYS`, `JOB_RETENTION_DAYS`, `SHARE_RETENTION_DAYS`, `STALE_JOB_DAYS`, `STALE_RUN_MINUTES` | optional | worker | Cleanup/retention policy. |
| `RATE_LIMIT_LOGIN_PER_MIN`, `RATE_LIMIT_SIGNUP_PER_MIN`, `RATE_LIMIT_FORGOT_PASSWORD_PER_MIN`, `RATE_LIMIT_RESET_PASSWORD_PER_MIN`, `RATE_LIMIT_UPLOAD_PER_MIN`, `RATE_LIMIT_ANALYSIS_PER_MIN`, `RATE_LIMIT_TEST_CREATE_PER_MIN`, `RATE_LIMIT_SANDBOX_CREATE_PER_MIN`, `RATE_LIMIT_SHARE_CREATE_PER_MIN`, `RATE_LIMIT_PUBLIC_REPORT_PER_MIN`, `RATE_LIMIT_REPORT_CREATE_PER_MIN`, `RATE_LIMIT_BILLING_READ_PER_MIN`, `RATE_LIMIT_BILLING_CHECKOUT_PER_MIN`, `RATE_LIMIT_BILLING_PORTAL_PER_MIN`, `RATE_LIMIT_BILLING_CHANGE_PER_MIN`, `RATE_LIMIT_BILLING_WEBHOOK_PER_MIN`, `RATE_LIMIT_AI_PER_MIN`, `RATE_LIMIT_BROWSER_SESSION_CREATE_PER_MIN` | optional | web | Per-minute limits; use a tested shared coordination provider before multi-instance rollout. |

## Billing and AI

| Variables | Required | Service | Notes |
| --- | --- | --- | --- |
| `BILLING_PROVIDER` | full billing only | web | `disabled`, `stripe`, `razorpay`, or development-only `fake`. Production defaults to disabled and rejects fake. |
| `BILLING_SECRET_KEY`, `BILLING_WEBHOOK_SECRET`, `BILLING_PRO_PRICE_ID`, `BILLING_BUSINESS_PRICE_ID`, `BILLING_PRO_AMOUNT`, `BILLING_BUSINESS_AMOUNT`, `BILLING_CURRENCY`, `BILLING_DELETION_POLICY`, `BILLING_PAST_DUE_GRACE_DAYS`, `BILLING_FAKE_WEBHOOK_SECRET` | selected Stripe/development provider only | web | Provider keys and webhook secrets are **secrets**. Never enable a live provider without owner approval and signed webhook E2E verification. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_PLAN_ID_PRO`, `RAZORPAY_PLAN_ID_BUSINESS`, `CSP_RAZORPAY` | Razorpay only | web/build | Key ID is provider-public; secret and webhook secret are **secrets**. `CSP_RAZORPAY=1` only widens CSP origins; it never enables billing by itself. Razorpay remains disabled for this preview. |
| `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL`, `AI_TIMEOUT`, `AI_TIMEOUT_MS`, `AI_MAX_REQUEST_BYTES`, `AI_MAX_CONTEXT_BYTES`, `AI_MAX_OUTPUT_TOKENS`, `AI_MAX_RESPONSE_BYTES`, `AI_MAX_CONCURRENCY`, `AI_MAX_CONCURRENCY_PER_USER`, `AI_RESULT_RETENTION_DAYS` | AI only | web/worker | `openai` needs `AI_API_KEY` (**secret**) and HTTPS base URL. Production rejects `fake`; controlled preview uses `disabled`. |

## Organization, API, webhook, and administration controls

These are server-only and optional unless the corresponding feature is intentionally enabled: `ORG_MAX_PER_USER`, `ORG_MAX_MEMBERS`, `ORG_MAX_PROJECTS`, `ORG_MAX_API_KEYS`, `ORG_MAX_WEBHOOKS`, `ORG_INVITATION_TTL_MS`, `ORG_DEFAULT_PLAN`, `AUDIT_RETENTION_DAYS`, `EXPORT_EXPIRY_MS`, `EXPORT_RETENTION_DAYS`, `PUBLIC_API_ENABLED`, `API_KEY_TTL_MS`, `API_KEY_MAX_SCOPES`, `API_RATE_LIMIT_READ_PER_MIN`, `API_RATE_LIMIT_UPLOAD_PER_MIN`, `API_RATE_LIMIT_ANALYSIS_PER_MIN`, `API_RATE_LIMIT_TEST_PER_MIN`, `API_RATE_LIMIT_MATRIX_PER_MIN`, `API_RATE_LIMIT_REPORT_PER_MIN`, `WEBHOOK_TIMEOUT`, `WEBHOOK_MAX_RETRIES`, `WEBHOOK_BACKOFF_BASE_MS`, `WEBHOOK_MAX_PAYLOAD_BYTES`, `WEBHOOK_HISTORY_PER_WEBHOOK`, `SSO_ENABLED`, `OIDC_ENABLED`, `SAML_ENABLED`, `ORG_MAX_CONCURRENCY`, `ORG_FAIRNESS_SCAN_LIMIT`, `JOB_PRIORITY_INTERACTIVE`, `JOB_PRIORITY_ENTERPRISE`, `JOB_PRIORITY_CI`, `JOB_PRIORITY_NORMAL`, and `MAINTENANCE_MODE`.

`ADMIN_API_ENABLED` defaults to false. If it is ever enabled, `ADMIN_API_TOKEN` is required and is a **secret**. Do not expose admin routes publicly or set either value for the controlled preview.

## Deployment validation

Use `npm run db:migrate` only against a backed-up persistent SQLite volume in the current implementation. `npm run db:migrate:status` reports migration status. `scripts/env-validate.mjs` and the legacy staging runbook are not proof of a deployed service; live dependency, backup, restore, and worker tests are still required before a full launch.
