# Production Readiness Audit

## v1.0 publishing update — 2026-11-04

This update supersedes historical phase-status summaries where they conflict with the code currently at `cff7cca` plus the release-preparation branch changes. The 34-phase core roadmap remains complete; this is a deployment-readiness assessment, not a Phase 35.

### Current conclusion

**Controlled public preview:** ready for owner hosting action.

**Full production service:** blocked by real infrastructure and implementation gates.

**Production certification:** not claimed.

The recommended first public surface is a Vercel-hosted controlled preview of browser-local inspection only. `EXTENSIONLAB_PREVIEW_MODE=controlled` visibly labels the preview and middleware blocks every stateful/API route before it can create local state or claim a cloud-backed capability. Vercel is not an execution environment for the product's Docker browser worker or persistent filesystem.

### Verified quality gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Node/runtime | PASS | Node `v22.22.3`, npm `10.9.8`; project now declares Node `>=22.11.0 <23`. |
| Locked install | PASS | `npm ci --no-audit --no-fund` with committed `package-lock.json`. |
| Typecheck | PASS | `npm run typecheck`. |
| Lint | PASS with one existing warning | `npm run lint`; `CheckoutReturn.tsx` has an exhaustive-deps warning. |
| Regression | PASS | `npm test`: 684/684 passed, 83 test files. |
| Production build | PASS with documented warnings | `npm run build`; optional dynamic import warnings for `redis` and `@aws-sdk/client-s3`, plus the lint warning. |
| Hydration | PASS locally; public browser-console verification pending owner deployment | Removed pre-hydration document mutation and `suppressHydrationWarning`; the production-rendered local page had matching CSP/HTML script nonces and no root nonce prop. |
| CSP | PASS by source | Per-request nonce policy in middleware; API CSP is restrictive; no `unsafe-eval` in production policy. |
| Secret hygiene | PASS | No tracked `.env`, database, key, or certificate file; ignored patterns confirmed. |
| Production dependency audit | PASS after targeted remediation | Initial `npm audit --omit=dev` found 1 critical / 3 high findings in locked Next.js 15.5.25, its Sharp dependency, nested PostCSS, and source-map-js. Updated Next.js and `eslint-config-next` to 15.5.29, refreshed Sharp to 0.35.5, and used narrowly scoped npm overrides for Next's nested PostCSS 8.5.32 and source-map-js 1.2.2. Final `npm audit --omit=dev --json`: 0 vulnerabilities. No `npm audit fix --force` was used. |
| Staging runbook temporary-file defect | FIXED | `scripts/staging-up.sh` keeps validator and E2E output in shell variables and preserves configuration exit code `3`. |

### Actual architecture findings

| Component | Actual status | Evidence / limitation |
| --- | --- | --- |
| Next.js web application | build-ready | Next.js 15 standalone output, Node runtime API routes, CSP middleware, Vercel preview config. |
| Database | **SQLite only; external PostgreSQL unavailable and unsupported by current driver** | `lib/db/client.ts` and `scripts/db-migrate.mjs` use `node:sqlite`; migration runner explicitly rejects PostgreSQL URLs. |
| Redis | unavailable | Coordination adapter is optional and dynamically imports `redis`, which is not a package dependency. No Redis service or live operation was tested. |
| Object storage | unavailable | S3 adapter is optional and dynamically imports `@aws-sdk/client-s3`, which is not a package dependency. No bucket or live integrity test was available. |
| Background worker | unavailable | Code and worker image exist, but no deployed worker registration, heartbeat, execution, retry, or graceful drain evidence exists. |
| Browser worker | unavailable | Docker CLI/daemon absent. No isolated extension execution, session lifecycle, artifact capture, or cleanup was run. |
| Authentication/session | code-level controls present; preview disabled | Secure HttpOnly/SameSite cookie configuration, CSRF same-origin checks, and ownership checks are preserved. Stateful auth routes are unavailable in controlled preview. |
| Razorpay | disabled | Provider implementation and signature handling exist, but no authorized live credentials/webhook E2E; preview uses `BILLING_PROVIDER=disabled`. |
| AI | disabled | Provider isolation and redaction code exist; preview uses `AI_PROVIDER=disabled`; no key is configured. |

### Deployment configuration finding

`docker-compose.prod.yml` documents the actual legacy single-host SQLite/local-storage topology with a worker that receives the Docker socket. It requires a persistent shared volume and a dedicated Docker trust boundary; it is not compatible with Vercel.

The separate `docker-compose.yml` / Phase 30 staging path is **not a verified v1.0 deployment topology**. It references service commands that are absent from the repository and health endpoints inconsistent with the actual `/api/health` route. It must not be used as evidence of PostgreSQL, Redis, object-storage, or browser-worker readiness. `scripts/staging-up.sh` remains an honest detector; its `/tmp` defect and exit-code handling have been corrected, but it cannot manufacture missing services or make the stale topology production-ready.

### Security observations

Preserved code-level controls include CSP nonce generation, restrictive API CSP, secure session-cookie flags in production, CSRF same-origin enforcement, server-side ownership checks, ZIP validation and size caps, package SHA-256 verification, validated storage keys, SSRF/private-network restrictions, sandbox resource restrictions, secret redaction, and payment webhook signature validation.

Runtime evidence remains unavailable for HTTPS headers at a public URL, session behavior behind a real proxy, cloud storage access controls, distributed rate limits, worker isolation, backup/restore, and external webhook delivery. These are release gates for a future full service, not PASS claims.

### Preview scope

**Enabled:** landing pages, navigation, responsive UI, documentation page, pricing information with disabled account/payment CTAs, and local browser-side package inspection.

**Disabled:** account creation/login/password reset, dashboards, reports, extensions, all stateful APIs, uploads to persistent storage, public API keys, webhooks, workers, automated and interactive browser tests, artifacts, AI, e-mail, Redis, S3, database access, and Razorpay.

### Outstanding owner actions

See `PUBLIC_PREVIEW_DEPLOYMENT.md` and `LAUNCH_CHECKLIST.md`. The owner must import the repository into Vercel, set encrypted controlled-preview variables, deploy `main`, and perform the public URL verification. No Vercel, Railway, Render, Fly, database, storage, Redis, Docker, payment, domain, or DNS credential was available in this session.

### Historical phase records

Phase 21–34 reports are retained for provenance. They document source-level and constrained-environment checks performed at their dates; they do not establish present-day availability of external infrastructure. No Phase 35 has been created.
