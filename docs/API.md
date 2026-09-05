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
`browser-matrix`, `webhooks`, `organization`. New keys default to the
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
