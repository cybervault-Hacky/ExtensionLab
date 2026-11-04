# ExtensionLab v1.0 — Controlled Public Preview Deployment

**Status on 2026-11-04:** `PUBLIC_PREVIEW_READY_FOR_OWNER_ACTION` — no hosting-provider account, project, or deployment credential is available in this environment. No public URL has been created.

This is deliberately a **controlled public preview**, not a production certification. It exposes the existing browser-local package inspection experience while preventing every route that requires persistent application infrastructure.

## Selected provider: Vercel (preview surface only)

Vercel is suitable for the public Next.js presentation layer because it supports Next.js 15, HTTPS, preview URLs, atomic deployments, deployment logs, and one-click rollback. It is **not** selected for the full ExtensionLab service:

| Capability | Controlled Vercel preview | Full product service |
| --- | --- | --- |
| Landing pages and browser-local ZIP inspection | enabled | enabled |
| Next.js server rendering | supported | supported only as web tier |
| Persistent SQLite volume | not available | required by the current implementation |
| PostgreSQL | not implemented by this build | blocked; migration runner rejects PostgreSQL URLs |
| Redis coordination | not configured; optional dependency is absent | blocked pending dependency, service, and E2E evidence |
| S3 object storage | not configured; optional AWS SDK is absent | blocked pending dependency, bucket, and E2E evidence |
| Background worker / Docker sandbox | not available | requires a dedicated Docker-capable worker host |
| Browser worker | not available | requires isolated Docker runtime and live E2E evidence |
| Razorpay | disabled | not enabled without owner-approved live configuration |

No infrastructure service is emulated or replaced with a memory, local-disk, or fake production fallback in this preview.

## Preview safety contract

Set the server-only variable below for the Vercel deployment:

```text
EXTENSIONLAB_PREVIEW_MODE=controlled
```

When it is set:

- The homepage and its local, in-browser inspection workflow remain available.
- A visible banner states which services are not configured.
- `/dashboard`, authentication, shared-report, and extension routes redirect to `/preview-unavailable`.
- Every `/api/*` route except the process liveness endpoint (`/api/health`) is intercepted in middleware and returns HTTP `503` with `PREVIEW_FEATURE_UNAVAILABLE` before it can initialize a database or storage provider.
- The pricing page shows account and payment controls as unavailable.
- Billing, Razorpay, AI, uploads, persistent accounts, API access, automated tests, interactive browser sessions, workers, and artifact generation remain unavailable. No fake result is returned.

The preview gate is server-only; it is not a `NEXT_PUBLIC_*` value and exposes no secret.

## Repository configuration

The repository contains `vercel.json` and an `engines` declaration:

- Node.js: `>=22.11.0 <23` (the application uses Node's `node:sqlite` API)
- package manager and lockfile: npm / `package-lock.json`
- install command: `npm ci --no-audit --no-fund`
- build command: `npm run build`
- Vercel framework: Next.js

Vercel manages the web process. For the separate Docker deployment documented in `DEPLOYMENT.md`, the container start command is `node server.js` from the Next standalone bundle; this is **not** used on Vercel.

## Owner action required

No Vercel credentials, Vercel project IDs, or alternative hosting credentials are present. The owner must perform these actions in the Vercel dashboard; do not paste secrets into this repository.

1. Review and merge the release change into `main`. Keep Vercel's Git production branch set to **`main`**.
2. Import `cybervault-Hacky/ExtensionLab` into a Vercel project. Do not attach or buy a custom domain; use the generated `*.vercel.app` URL.
3. In **Project Settings → Environment Variables**, add these values for both Preview and Production environments. Vercel stores them encrypted.

   | Variable | Value / handling |
   | --- | --- |
   | `APP_ENV` | `production` |
   | `APP_URL` | the generated `https://<project>.vercel.app` origin after its first deploy; redeploy after setting it |
   | `SESSION_SECRET` | a new random secret of at least 32 characters; generate locally with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
   | `EMAIL_PROVIDER` | `noop` |
   | `BILLING_PROVIDER` | `disabled` |
   | `AI_PROVIDER` | `disabled` |
   | `WORKER_MODE` | `disabled` |
   | `SANDBOX_DISABLED` | `true` |
   | `EXTENSIONLAB_PREVIEW_MODE` | `controlled` |
   | `LOG_LEVEL` | `info` |

   Do **not** configure a placeholder database URL, local storage path, fake billing provider, Razorpay key, AI key, Redis URL, S3 credential, Docker socket, or `NEXT_PUBLIC_*` secret for this preview.
4. Confirm the detected install and build commands match this document, then deploy `main`.
5. Record the generated URL in this document and `PRODUCTION_READINESS.md` only after the checks below pass.

## Required verification after deployment

Use the real generated URL, substituting `PREVIEW_URL` below. Never report success based solely on a green build.

```bash
curl -fsSI "$PREVIEW_URL/"
curl -fsS "$PREVIEW_URL/api/health"
curl -sS -o /dev/null -w '%{http_code}\n' "$PREVIEW_URL/api/ready"       # must be 503
curl -sS -o /dev/null -w '%{http_code}\n' "$PREVIEW_URL/api/auth/signup" # must be 503
curl -sSI "$PREVIEW_URL/dashboard"                                      # must redirect to /preview-unavailable
```

Then verify in a browser:

- HTTPS is valid and the homepage, navigation, mobile layout, favicon, title, and metadata render.
- The preview banner is visible and accurately describes the restriction.
- Local ZIP inspection works without a network request carrying the ZIP to an API.
- Pricing controls state that they are unavailable in preview.
- Login, signup, dashboard, reports, and extensions show the honest unavailable page.
- `POST /api/auth/signup`, `POST /api/billing/checkout`, and test/browser API requests return `503`; no account, job, payment, or report is created.
- `/api/health` returns only liveness information; it must not claim dependency readiness.
- The HTML page has a nonce-bearing CSP; API response CSP is `default-src 'none'; frame-ancestors 'none'`.
- Browser console has no hydration warning or CSP violation. Inspect response headers and deployment logs without printing environment values.

## Rollback

For a faulty preview, use Vercel's deployment rollback/promotion control to restore the previous deployment, or revert the release commit on `main` and let the Git deployment run. If a safety concern appears, set `EXTENSIONLAB_PREVIEW_MODE=controlled` (or keep it set), redeploy, and disable the Vercel project if necessary. No data migration or paid service is involved in this preview.

## Upgrade path to a full service

A future full deployment requires owner-approved infrastructure and evidence for a persistent database, object storage, worker, Docker-isolated browser worker, backups and restore, monitoring, and failure recovery. The current code does not support PostgreSQL despite legacy planning documents that mention it; that gap must be resolved as a separately approved architecture implementation, not papered over during preview deployment.
