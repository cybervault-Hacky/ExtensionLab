# ExtensionLab v1.0 Launch Checklist

**Release target:** controlled public preview only.

**Last audited:** 2026-11-04.

**Current verdict:** `PUBLIC_PREVIEW_READY_FOR_OWNER_ACTION`.

A checked item is evidence, not an assumption. Do not mark a service ready because its UI route renders.

## Completed repository gates

- [x] Active branch and starting commit inspected: `arena/635487ae-extensionlab` / `cff7cca9095175d18f91a7ca09dee0065971d3c8`.
- [x] Working tree was clean before release-preparation edits; no pre-existing work was overwritten.
- [x] Remote `origin` points to `https://github.com/cybervault-Hacky/ExtensionLab.git`; current remote `main` is `cff7cca`.
- [x] Node/npm runtime checked: Node `v22.22.3`, npm `10.9.8`; package lock present and used with `npm ci`.
- [x] `npm run typecheck` passed.
- [x] `npm run lint` passed with one existing non-blocking `react-hooks/exhaustive-deps` warning in `components/billing/CheckoutReturn.tsx`.
- [x] `npm test` passed: **684/684 tests**, 83 files.
- [x] `npm run build` passed. It emitted optional dynamic-import warnings for absent Redis and AWS S3 SDK packages, plus the same non-blocking lint warning.
- [x] Build output is Next.js standalone; `vercel.json` uses locked npm installation and `npm run build`.
- [x] `.env*`, local data, storage, archives, database files, and Vercel project state are ignored; no tracked key, database, or environment file was found.
- [x] Production dependency audit is clean: after targeted non-breaking dependency remediation, `npm audit --omit=dev --json` reports 0 vulnerabilities; no forced audit fix was used.
- [x] CSP nonce root cause corrected without `suppressHydrationWarning`: the pre-hydration theme script and its server-only nonce attribute were removed. Next.js receives the nonce-bearing CSP request header from middleware for its own scripts; preference changes occur after hydration.
- [x] `scripts/staging-up.sh` no longer writes validator/e2e output to `/tmp`; configuration failures now keep their documented exit code `3` rather than being overwritten by an infrastructure skip.
- [x] Controlled-preview safety gate implemented and documented.
- [x] Local standalone production render verified with controlled-preview variables: HTML CSP nonce matched Next script nonce; banner rendered; dashboard redirected; readiness and signup routes returned 503; health stayed 200; pricing CTAs were disabled.

## Owner action before public preview

- [ ] Review and merge the release branch into `main`.
- [ ] Import the GitHub repository into a Vercel project with production branch set to `main`.
- [ ] Add encrypted preview environment values from `ENVIRONMENT_VARIABLES.md`; set `EXTENSIONLAB_PREVIEW_MODE=controlled`.
- [ ] Do not buy a plan, domain, or add DNS. Use the generated `vercel.app` URL.
- [ ] Confirm Vercel deployment build logs show `npm ci --no-audit --no-fund` and `npm run build` succeeded.
- [ ] Record the generated preview URL only after it is reachable over HTTPS.
- [ ] Verify homepage, navigation, mobile layout, favicon, title, description, and Open Graph metadata at the actual URL.
- [ ] Verify `GET /api/health` is 200 and contains liveness only.
- [ ] Verify `/api/ready`, signup, billing, upload/test, browser, AI, and other APIs return 503 `PREVIEW_FEATURE_UNAVAILABLE`.
- [ ] Verify dashboard, account, report, and extension routes redirect to the honest unavailable page.
- [ ] Verify the browser-local ZIP inspection workflow works and does not submit the ZIP to an API.
- [ ] Inspect browser console: no hydration mismatch and no CSP violation.
- [ ] Inspect response headers: HTTPS, CSP nonce on HTML, restrictive API CSP, no unexpected public cookie or secret.
- [ ] Inspect deployment logs for uncaught errors without exposing environment values.

## Full-service gates — intentionally not checked

- [ ] Persistent PostgreSQL connection, migration, backup, restore, and TLS verified. **Blocked:** current driver is SQLite-only and rejects PostgreSQL URLs.
- [ ] Redis connection, cross-process queue/limiter operation, retry, and failure recovery verified. **Blocked:** no Redis service or `redis` package/E2E evidence.
- [ ] Private S3-compatible bucket upload/download/SHA-256/retention/access-control verified. **Blocked:** no bucket or AWS SDK/E2E evidence.
- [ ] Dedicated background worker heartbeat, claim, drain, retry, and graceful shutdown verified. **Blocked:** no worker host.
- [ ] Dedicated browser worker sandbox, extension loading, artifact capture, cleanup, resource limits, and isolation verified. **Blocked:** Docker unavailable; Vercel cannot host this runner.
- [ ] Live Razorpay payment and signed webhook lifecycle verified. **Disabled by design:** no live payments are authorized for this preview.
- [ ] Real multi-user authorization, storage, negative security, recovery, and load E2E evidence collected.
- [ ] Backup and restore runbook exercised against the real selected datastore.
- [ ] Monitoring, alerting, on-call ownership, and incident contacts approved.

## Legal and content review

- [ ] Owner review of privacy policy, terms of service, and support/contact channel. The current footer labels Privacy and Terms but does not link to documents.
- [ ] Owner review of pricing and claims for the preview. Payment/account controls are disabled; do not advertise them as available.
- [ ] Owner review of custom 404/error presentation. There is no application-specific `not-found.tsx` or error boundary; Next.js default handling remains.
- [ ] No certification, compliance badge, or testimonial has been added without evidence.

## Rollback

- [x] Preview rollback process documented in `PUBLIC_PREVIEW_DEPLOYMENT.md`.
- [ ] Owner confirms Vercel deployment rollback access before launch.
