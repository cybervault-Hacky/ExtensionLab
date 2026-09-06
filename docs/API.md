# Public API (v1)

ExtensionLab exposes a versioned HTTPS JSON API for CI pipelines and
integrations. The in-app documentation lives at `/docs/api`; this page is the
complete reference.

The public API is **additive**: internal endpoints used by the dashboard are
not part of the contract and may change; `/api/v1/*` may only gain fields
within a version.

## Authentication

```
Authorization: Bearer el_<prefix>_<secret>
```

API keys are organization-scoped (see `docs/API_KEYS.md`). Requests
authenticate, then authorize by scope, then by the key creator's organization
role, then pass through the same quota, entitlement and concurrency services
as dashboard traffic — an API key never bypasses plan or organization limits.
Feature entitlements (API access, browser matrices, CI gates) come from the
**organization's** plan; per-user run/analysis quotas are drawn from the key
creator's personal plan, which is the conservative interpretation: API traffic
can never run *more* than the same user could in the dashboard.

## Scopes

`resource:read|write` for `packages`, `analysis`, `tests`, `reports`,
`browser-matrix`, `browser-sessions`, `webhooks`, `organization`. New keys default to the
least-privilege read set (`packages:read analysis:read tests:read`); there is
no unrestricted scope and an empty scope list is rejected.

## Endpoints

| Method & path | Scope | Notes |
| --- | --- | --- |
| `POST /api/v1/packages` | `packages:write` | Multipart `file` (≤ 25 MB ZIP). Uploads, stores and statically analyzes in one step. `Idempotency-Key` supported. 201. |
| `GET /api/v1/packages/:id` | `packages:read` | Metadata only — no source bytes. |
| `POST /api/v1/test-runs` | `tests:write` | `{ packageId, suiteId?, browsers?, testUrl? }`. One Chromium browser → single test run; several `browsers` → browser matrix. 202. |
| `GET /api/v1/test-runs/:id` | `tests:read` | Status, outcome, scores, per-test results. |
| `GET /api/v1/browser-matrices` | `browser-matrix:read` | Paginated (`page`, `limit` ≤ 50). |
| `GET /api/v1/browser-matrices/:id` | `browser-matrix:read` | Matrix view + comparison + deterministic CI gate verdict when the organization configured quality gates. |
| `GET /api/v1/reports/:id` | `reports:read` | Sanitized report view (same projection as the dashboard). |
| `GET /api/v1/jobs/:id` | `tests:read` | Job status, attempts, error code. |
| `GET /api/v1/organization` | `organization:read` | Organization, plan, seats, entitlements, key info. |
| `POST /api/v1/browser-sessions` | `browser-sessions:write` | `{ packageId }` → create + queue an interactive session for an org package owned by the key creator. 202. |
| `GET /api/v1/browser-sessions/:id` | `browser-sessions:read` | Safe status view (no runtime internals: no tokens, ports or ring payloads). |
| `POST /api/v1/browser-sessions/:id/stop` | `browser-sessions:write` | Deterministic teardown; only the session creator may stop it via the API. Audited `via: api`. |

Interactive sessions deliberately expose **only** create / status / stop over
the public API. Input control, navigation, popup and inspection are not public
endpoints: the typed interactive surface stays bound to the authenticated
dashboard session (same-origin), so an API key can never type, click or read
inside someone's browser.

Cross-organization ids return `404 NOT_FOUND` — identical to a missing
resource; no existence oracle exists.

## Idempotency

Send `Idempotency-Key` on `POST` endpoints that create work.

- Same key + same request fingerprint → the stored response is replayed
  (marked as a replay by status/body equality), the operation does not re-run.
- Same key + different body → `409 IDEMPOTENCY_CONFLICT`.
- In-flight keys conflict until completion.
- Failed operations are not cached; retries re-run.
- Records are scoped to the owner (organization or personal workspace) and
  expire after 24 hours; the cleanup job sweeps them.

## Rate limiting

Limits are enforced per **key**, per **organization + endpoint class**, and
per **IP**, and are separate from plan quotas. Classes and defaults
(override via environment, per minute): read 240, upload 30, analysis 60,
test 30, matrix 10, report 120.

Every response carries `x-ratelimit-limit`, `x-ratelimit-remaining` and
`x-ratelimit-reset`; exceeded limits return `429 RATE_LIMITED` with
`Retry-After`. In multi-worker deployments, counters live in the coordination
store (Redis; in-memory for single-node development).

## Errors

One envelope, always:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Resource not found.",
    "requestId": "req_ab12cd34"
  }
}
```

`requestId` matches the `x-request-id` response header. Responses never
contain stack traces, file paths, SQL, hostnames or container ids. Common
codes: `AUTH_REQUIRED` (401), `API_SCOPE_DENIED` (403), `NOT_FOUND` (404),
`INVALID_INPUT` (400), `INVALID_EXTENSION` (400), `IDEMPOTENCY_CONFLICT`
(409), `RATE_LIMITED` (429), `PAYMENT_REQUIRED` (402), `API_DISABLED` (503).

## CI/CD quality gates

Organizations define deterministic quality gates (minimum health score,
maximum critical/high findings, required tests, required browsers, regression
policy). `GET /api/v1/browser-matrices/:id` returns the server-computed
verdict:

- `PASS` — every applicable check passed.
- `FAIL` — at least one check failed.
- `NOT_EVALUATED` — no check could run.

Infrastructure failures (sandbox unavailable, browser infra errors) are never
reported as `PASS`; a check whose evidence is missing is `not_evaluated` and
the overall verdict can only be `PASS` when all applicable checks genuinely
passed.

### GitHub Actions

```yaml
name: extension-quality
on: [push]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Upload & analyze
        run: |
          curl -sf -X POST "$BASE_URL/api/v1/packages" \
            -H "Authorization: Bearer $EXTENSIONLAB_API_KEY" \
            -H "Idempotency-Key: ${{ github.sha }}" \
            -F "file=@extension.zip" | tee analyze.json
      - name: Run browser matrix
        run: |
          curl -sf -X POST "$BASE_URL/api/v1/test-runs" \
            -H "Authorization: Bearer $EXTENSIONLAB_API_KEY" \
            -H "Idempotency-Key: ${{ github.sha }}-matrix" \
            -H "content-type: application/json" \
            -d '{"packageId":"'"$(jq -r .package.id analyze.json)"'","browsers":["chromium","edge","firefox"]}'
      - name: Wait & gate
        run: |
          # poll GET /api/v1/browser-matrices/:id until terminal, then:
          test "$(jq -r .policy.result matrix.json)" = "PASS"
```

GitLab CI uses the same calls in `script:` blocks; Jenkins in `sh` steps.
There is no proprietary runner — the contract is plain HTTPS + JSON, which is
also the documented SDK/CLI contract (a thin wrapper over these endpoints).

## Versioning

Breaking changes ship as `/api/v2` with a migration window; within a version
fields are only added. Disable the public API entirely with
`PUBLIC_API_ENABLED=false` (routes then fail closed with `API_DISABLED`).

## Phase 13 admin & report endpoints

Admin API (token-authenticated, read-heavy, no exec/CDP):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/admin/workers` | fleet: registered workers, derived states |
| POST | `/api/admin/workers/{ref}/state` | `{"desired":"drain"\|"disable"\|"ready"}` |
| GET | `/api/admin/capacity` | queue depth, live sessions, slots, failures by class |
| GET | `/api/admin/failures` | recent failures grouped by failure class |
| GET | `/api/admin/metrics` | metric registry snapshot |
| POST | `/api/admin/reconcile` | out-of-band orphan-container reconcile |

User API:

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/reports/{id}/pin` | pin a report (protects its artifacts from retention) |
| DELETE | `/api/reports/{id}/pin` | unpin |

## Phase 15: saved-test CI endpoints

| Method & path | Scope | Notes |
| --- | --- | --- |
| `POST /api/v1/tests/:testId/runs` | `tests:write` | Trigger a run of a saved test or suite. Safe params only: `version`, `browser`/`browsers`, `variables`, `testUrl` — everything else is rejected; all values are validated server-side. Honors `Idempotency-Key`. 202 with `runs[]`. |
| `GET /api/v1/tests/:testId/runs` | `tests:read` | Paginated run history for the test with CI statuses and exit codes. |
| `GET /api/v1/tests/:testId/runs/:runId` | `tests:read` | Poll one run: `QUEUED`/`STARTING`/`RUNNING`/`COMPLETED`/`FAILED`/`TIMEOUT`/`CANCELLED`, totals and per-test results once finished. `exitCode` is 0 only on `COMPLETED`. |

Dashboard endpoints (session auth, same-origin): `GET/POST /api/tests/saved`,
`GET/PATCH/POST /api/tests/saved/:testId` (detail/update/duplicate),
`POST /api/tests/saved/:testId/run`, `GET /api/tests/saved/:testId/runs`,
`GET /api/tests/saved/:testId/export`, `GET/POST /api/tests/saved/:testId/baseline`
(`?runId=` compares), `POST /api/tests/saved/import`, `GET/POST
/api/tests/suites`, `GET /api/tests/suites/:suiteId`,
`POST /api/tests/suites/:suiteId/run`, `GET /api/tests/templates`.
