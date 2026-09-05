# Security

This document summarises the security model that Phase 6 preserves from
Phases 1–5 and the controls it adds. Report vulnerabilities privately to the
maintainers; do not open public issues for exploitable findings.

## Principles

1. **Uploaded extension code is untrusted data.** It is validated and
   statically analysed on the server, but it is only ever *executed* inside a
   disposable Docker container running Chromium. Neither the web process nor
   the worker evaluates, imports or injects uploaded JavaScript/HTML.
2. **Ownership is enforced in the data layer.** Every repository query for
   extensions, packages, runs, artifacts, reports, jobs and shares is scoped
   by `user_id`. Route parameters are never trusted for authorisation.
3. **Fail closed.** Production refuses to start with missing secrets or unsafe
   settings, readiness reports degraded capabilities honestly, and runs that
   cannot execute end as `INFRASTRUCTURE_ERROR` — results are never faked.
4. **Never leak internals.** Errors, logs, API responses and public reports
   exclude stack traces, file paths, hostnames, container ids, socket paths,
   tokens and cookies.

## Sandbox isolation (Phase 3, unchanged)

Each automated test run creates a fresh container from the pinned
`SANDBOX_IMAGE` (`sandbox/Dockerfile`, runs as `node`, no shell entrypoint):

| Control | Flag |
| --- | --- |
| Non-root | `--user node` |
| No capabilities | `--cap-drop ALL` |
| No privilege escalation | `--security-opt no-new-privileges` |
| Read-only root filesystem | `--read-only`, writable only via `--tmpfs /tmp:rw,noexec,nosuid,size=256m` and a size-limited profile cache |
| Resource limits | `-m <SANDBOX_MEMORY_LIMIT>`, `--cpus <SANDBOX_CPU_LIMIT>`, `--pids-limit 200`, `--shm-size 256m`, `--init` |
| Network | `bridge` with the runner-side SSRF policy (private ranges, metadata endpoints and non-http(s) schemes blocked; `SANDBOX_ALLOW_HTTP=false`) or `none` |
| Control plane | loopback-only published port (`127.0.0.1:<random>`), per-container random `RUNNER_TOKEN`, allow-listed operations only (`start`, `stop`, `reload`, `open-url`, `restart-extension`, `clear-console`) |
| No host access | no bind mounts, no `--privileged`, no host network/PID/IPC, no Docker socket; the package is copied in with `docker cp` |
| Lifetime | `SANDBOX_TIMEOUT`, orphan sweeps, `extensionlab.sandbox=1` label for cleanup, destroyed on completion, cancellation, timeout and worker shutdown |

`tests/phase6/docker-security.test.ts` asserts these flags on the exact
`docker create` argument list; the E2E suite inspects a live container.

The worker is the only process that talks to Docker. Access to the Docker
socket is equivalent to root on that host, so run the worker on a dedicated
host/VM (or behind a socket proxy limiting it to `create/cp/start/inspect/
rm/ps/image inspect/info`) and never mount the socket into the web
container. `docker-compose.prod.yml` follows this split.

## Web application

- **Authentication**: scrypt password hashes, HttpOnly `SameSite=Lax`
  cookies (`Secure` in production), database-backed sessions with hashed
  tokens, same-origin checks on state-changing routes, generic messages that
  avoid account enumeration.
- **Password reset**: random 32-byte tokens, only the SHA-256 hash is stored,
  30-minute TTL, single use, previous tokens invalidated. The raw token
  exists once inside the queued `EMAIL` job payload (needed to build the
  link) and is redacted from the row the moment the job finishes. Tokens are
  never logged; the development file drop (`EXTENSIONLAB_RESET_DEV_DIR`) is
  rejected by production configuration.
- **Content Security Policy** (`lib/security/csp.ts`, applied in
  `middleware.ts`): per-request nonce, `script-src 'self' 'nonce-…'
  'strict-dynamic'` (no `unsafe-eval` in production; enabled only for the
  Next.js dev overlay), `object-src 'none'`, `frame-src 'none'`,
  `base-uri 'self'`, `form-action 'self'`, `upgrade-insecure-requests` in
  production. `style-src 'unsafe-inline'` remains because React renders
  inline style attributes; it does not affect script execution. API
  responses use `default-src 'none'; frame-ancestors 'none'` and
  `Cache-Control: no-store`. Additional headers: `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Frame-Options`, `Permissions-Policy`.
- **Rate limiting** (`lib/auth/rate-limit-policy.ts`): login, signup,
  forgot/reset password, upload, test creation, sandbox creation, report
  creation, share creation and the public report page are throttled per
  client per minute with `RATE_LIMIT_*_PER_MIN`. Job back-pressure
  (`JOB_MAX_QUEUED_PER_USER`, `JOB_MAX_QUEUE_LENGTH`), per-user sandbox
  concurrency and monthly quotas limit resource abuse further.
- **Uploads**: size limit (`PLAN_MAX_EXTENSION_SIZE`, default 25 MB), ZIP
  structure and manifest validation, entry count/size limits and traversal
  checks in `lib/extension/` before anything touches storage.
- **Artifacts**: served only to the owner through `/api/artifacts/:id` with
  `Content-Disposition`, `nosniff`, `no-store` and a sandboxed CSP. Public
  reports include counts and safe summaries only — no blobs, keys or URLs.
- **No arbitrary execution surface**: there are no `/api/exec`, `/api/shell`
  or `/api/command` routes, no raw Docker API proxy and no client access to
  container ids or host information (enforced by tests).
- **Account deletion**: cancels active jobs, deletes the user in one
  transaction (cascading to packages, runs, jobs, artifacts, reservations,
  sessions, reset tokens, reports, shares) and then removes blobs.

## Secrets and configuration

- `.env.example` contains placeholders only; `.env*` files, databases,
  storage directories, uploads and reset-token drops are ignored by Git.
- `lib/config/env.ts` reads every variable once. Production requires
  `SESSION_SECRET` (≥ 32 chars), `https://` `APP_URL`, an explicit
  `EMAIL_PROVIDER` (`http`/`noop`), and rejects `console`/`file` e-mail and
  the reset-token dev directory.
- `describeConfig()` (logged at startup) contains no secrets. The HTTP e-mail
  provider sends the bearer token in a header only and never logs responses.
- Sandbox containers receive exactly two environment variables:
  `RUNNER_TOKEN` (random, per container) and `SANDBOX_ID`. User sessions,
  database paths and application secrets never enter a container.

## Billing (Phase 7)

- **Server-side authority.** Entitlements are derived from the
  `subscriptions` table, which is written only by the webhook processor and
  the owner-checked checkout confirmation, both from provider objects. There
  is no set-plan API, no client-supplied price/currency/plan state, and the
  UI's plan badges are decoration — every product route calls
  `lib/billing/entitlements.ts` before doing work.
- **Checkout.** `POST /api/billing/checkout` accepts only `planId`; the price
  id comes from configuration. Sessions are recorded with their owner so the
  return page can confirm only its own session (`session_id` in the URL grants
  nothing; another user's id yields `unknown`).
- **Webhook.** Signature over the raw body (`t=…,v1=…` HMAC-SHA256, 300 s
  tolerance, constant-time compare); missing/invalid/tampered/stale
  signatures → `400`; body cap 1 MB; rate limited; idempotent through the
  `billing_events` unique index; responses carry no stack traces or provider
  payloads. It is the only unauthenticated, CSRF-exempt billing route.
- **CSRF and auth.** Every other `/api/billing/*` route requires a session
  and passes `requireSameOrigin`; checkout/portal/change actions are rate
  limited per user + IP (`RATE_LIMIT_BILLING_*`).
- **Data minimisation.** No card data, no payment methods, no raw provider
  payloads are stored; invoices are linked, not mirrored. Clients receive
  derived state only (plan, state, period, usage) — never provider customer
  / subscription / event ids or secrets.
- **Secrets.** `BILLING_SECRET_KEY` and `BILLING_WEBHOOK_SECRET` come from
  the environment, are sent only in the `Authorization` header / used for
  HMAC, are absent from `describeConfig()`, logs and the client bundle
  (asserted by `tests/phase7/product-entitlements.test.ts`), and production
  refuses test keys and the fake provider.
- **Audit and observability.** `checkout_started`,
  `subscription_created/activated/changed/cancelled/reactivated`,
  `payment_succeeded`, `payment_failed` audit rows (amount + currency only);
  `billing.*` metrics and structured logs with request ids.
- **Account deletion** cancels the provider subscription first and aborts
  (retryable) if the provider call fails, so a deleted account can never keep
  being charged.

## Logging

Structured JSON logs (`lib/observability/logger.ts`) include timestamps,
levels, event names and correlation ids. Values under keys matching
password, token, cookie, authorization, api key, credential, session,
source, body, payload or `*_json` are replaced recursively with
`[redacted]`, and messages passed through `scrubDiagnostic()` have paths and
long hex ids removed. Extension source, request bodies and private report
content are never logged. Request/job ids (`req_…`, `job_…`) are the only
identifiers surfaced to users in error messages (`Reference: req_xxxxx`).

## Dependencies and images

- Lockfile-pinned npm dependencies; no new runtime dependencies were added
  for Phase 6 (queue, storage, e-mail and logging use Node built-ins).
- Application images run as uid 10001, contain production dependencies only,
  and the web image has no Docker CLI. The worker image pins the Docker CLI
  version through a build argument.
- The sandbox image is built from `node:22-bookworm-slim` with Chromium and
  no package managers or shells exposed to the runner control API.

## Residual risks and recommendations

- Docker containers share the host kernel. For hostile multi-tenant
  workloads consider gVisor/Kata or a VM-per-run executor; the
  `SandboxDriver` interface is the extension point.
- In-memory rate limiting is per web process; place a proxy-level limit in
  front of the web service when running several replicas.
- Chromium in the sandbox runs with `--no-sandbox` inside the container
  (container isolation is the boundary); keep the image updated and keep
  `SANDBOX_NETWORK_MODE=restricted` or `none`.
