# Test Automation Studio (Phase 15)

The Test Automation Studio lets teams build **repeatable extension tests
without writing arbitrary JavaScript, shell commands or browser automation
code**. A saved test is plain data: allowlisted actions, allowlisted
assertions, bounded typed variables and metadata. It is validated at save
time, at import time and again at execution time, and it always runs against
the exact package bytes it was authored for, in a fresh isolated browser,
through the same Phase 13 queue/worker machinery as every other run.

The studio extends existing systems — it does not duplicate them:

| Capability | Reused from |
| --- | --- |
| Execution engine (12 actions, 16 assertions, capability gates) | Phase 4 `lib/testing/test-runner.ts` |
| Queue, workers, cancellation, heartbeats | Phase 13 `lib/jobs` |
| Browser matrix + per-failure classification | Phase 9 `lib/testing/matrix-service.ts`, `regression.ts` |
| API keys, scopes, rate limits, org auth | Phase 10 `lib/api-keys`, `lib/api/v1-support` |
| Entitlements, quota reservation, plans | Phase 7/14 `lib/billing` |
| Templates | Phase 9 `lib/testing/templates.ts` |
| Webhooks (`test_run.created/completed/failed`) | Phase 10 `lib/webhooks` |
| Idempotency (`Idempotency-Key`) | Phase 10 `lib/idempotency` |

## Journey

Open Extension → **Test Automation** (`/dashboard/tests/studio`) → create a
test → build Setup / Actions / Assertions / Cleanup → save (DRAFT → ACTIVE) →
run → view results in Recent Runs / on the test page → save a run as baseline
→ run manually or via API/CI.

## What a saved test can contain (and never can)

**Actions (exactly the Phase 4 allowlist):** `open_url`, `reload_page`,
`wait`, `click`, `type`, `select`, `scroll`, `inspect_text`,
`inspect_element`, `open_popup`, `clear_console`, `capture_screenshot`.

**Assertions (exactly the engine's allowlist):** `extension_exists`-family,
`text_contains`, `url_equals`, `url_contains`, `console_contains`,
`console_not_contains`, `network_request_seen`, `network_status_equals`,
`extension_loaded`, `content_script_detected`, `service_worker_detected`,
`popup_available`, `runtime_error_none`, `network_4xx_none`,
`network_5xx_none`.

**Never possible** — rejected by the validator at save, import and execution:
`execute_js`, `evaluate`, `run_shell`, `raw_cdp`, `docker_exec`,
`arbitrary_command`, unknown fields at any level, positional selectors
(`nth-child`), deep descendant paths, oversized values, unlimited timeouts.
The engine additionally re-applies `isSafeAction` per action at run time.

## Selectors

Selectors must pass the existing `validateSelector` grammar: `#id`, `.class`,
tag, space-separated tags, `[data-testid="x"]`. The builder's selector
assistant can only *generate* selectors from those strategies (stable id →
data-testid → stable tag → single attribute); `nth-child` and deep paths
cannot be produced at all. Selectors are never passed to browser APIs without
server validation.

## Variables

- Predefined, server-resolved: `{{extension_name}}`, `{{browser}}`,
  `{{test_url}}`, `{{package_version}}`.
- User-defined, typed: `text` (bounded), `number`, `url` (http/https only),
  `boolean`. Runtime values are type-checked server-side.
- Resolution is pure string substitution — variables are **never evaluated as
  code**.
- Secrets are **not implemented** and ordinary variables must never hold
  passwords: the platform stores no encrypted variable values because the
  current architecture has no per-tenant key management. This is a deliberate
  honest limitation, not an oversight.

## Lifecycle and versioning

- Status: `DRAFT` → `ACTIVE` → `ARCHIVED` (immutable, not runnable).
- Editing a definition writes a **new immutable version row** (v1, v2, …).
  The current definition is copied; past versions never change.
- Every run records the exact `saved_test_id` + `saved_test_version` it
  executed. Historical runs are immutable.
- Duplicate creates a fresh identity at v1 — it never clones run history.
- Concurrent edits are detected: `expectedVersion` mismatch → `CONFLICT`,
  the second editor must reload.
- Execution binds to the package **SHA-256**. If the stored package bytes no
  longer match, the run is refused (`SHA-256 mismatch`) — never a silent
  substitution.

## Suites

- Deterministic ordering: array position is the execution order (persisted).
- Explicit dependencies on **earlier members only** (cycles and forward
  references are rejected at save time); they reuse the engine's existing
  `dependsOn` skip semantics.
- Failure policy: `stop` (remaining tests are explicitly marked *skipped*,
  recorded, never silently dropped) or `continue`.
- A suite executes as **one run in one fresh browser**; therefore all members
  must be authored against the same package bytes (enforced at save time).
  Before/after setup and cleanup are the members' own Setup/Cleanup steps —
  built from the same allowlist.

## Runs and results

Run pipeline: validate → entitlement → per-user concurrency → quota
reservation → queue → worker → fresh browser → exact package → execute →
assertions → artifacts → results. Result values come **only** from actual
execution: `PASSED`, `FAILED`, `SKIPPED`, `TIMEOUT`, `CANCELLED`, `ERROR`
(plus infrastructure outcomes). If no worker can execute the job the run is
recorded as an infrastructure failure — the platform never fakes success.

Per-step detail, assertion outcomes, failure evidence (screenshots, console,
network, runtime events) respect the existing artifact-retention rules. Test
**definitions** are never deleted when runs/artifacts age out.

## Baselines and regression classification

“Save Run as Baseline” pins a finished run. Comparing a later run against the
baseline is a **pure deterministic function** (§48):

`NEW_FAILURE`, `FIXED_FAILURE`, `UNCHANGED_FAILURE`, `NEW_WARNING`,
`PERFORMANCE_REGRESSION`, `NO_REGRESSION`

Performance regression requires ≥ 50% **and** ≥ 3 s slowdown. AI is never
involved in classification. **Screenshot diffing is not implemented** —
screenshots are kept as evidence only; the platform does not claim
pixel-comparison capabilities it does not have.

## Analytics and flakiness

Pass rate, average duration, last run/last failure are computed from real
runs and labeled honestly on small samples. Flaky detection is deterministic:
≥ 4 recent runs with ≥ 3 pass↔fail alternations. A single failure never flags
a test as flaky.

## Matrix runs

Chromium, Edge and Firefox only (no Safari). Selecting browsers beyond
Chromium requires the existing cross-browser entitlement; per-test browser
targets bound what a run may use. Per-browser failures reuse the Phase 9
deterministic classification (`EXTENSION_ERROR` / `BROWSER_INCOMPATIBILITY` /
`UNSUPPORTED` / `INFRASTRUCTURE_ERROR`).

## Templates

Built-in templates (Extension Load, Popup, Content Script, Service Worker,
Options Page, Permission Smoke, Network Smoke) are projections of the Phase 9
template registry re-validated through the same saved-test validator. “Use
Template” copies into your draft; built-ins are never modified.

## Permissions, quotas, retention

- Workspace roles: mutations in an organization require the existing
  `org:tests:run` permission; reads need membership.
- API scopes: existing `tests:read` / `tests:write` — no new scopes.
- Billing is enforced server-side for every run (dashboard and API alike):
  reserve → queue → run → consume/release; API keys never bypass plan limits.
- Artifact retention follows the plan; definitions are retained independently.

## Import / export

Export produces bounded JSON (`schemaVersion: 1`, `kind:
"extensionlab.saved-test"`) with definition and metadata only — never
secrets, runs or organization internals. Import treats the file as untrusted:
size-bounded, strict schema, unknown-field rejection, full re-validation;
always saved as a DRAFT owned by the importer; any error rejects the whole
file atomically.

## Security boundary (unchanged)

No arbitrary JS/eval, shell, CDP, Docker exec, arbitrary browser flags, host
filesystem, Docker socket or host network access. Cross-tenant package or
test access is impossible: every read is scoped to the owner or the
organization. AI features (failure analysis) remain advisory and never
execute code, modify tests or decide regression status.

## Database

Migration `012_phase15_test_studio.sql` adds `saved_tests`,
`saved_test_versions`, `saved_test_suites`, `saved_test_suite_items`,
`saved_test_baselines`, and binds `test_runs.saved_test_id` /
`saved_test_version`. Indexes cover organization/user/package lookups only.

## See also

- `docs/CI_CD.md` — triggering runs from CI with placeholder credentials.
- `docs/API.md` — the `/api/v1/tests/:testId/runs` endpoints.
- `tests/phase15/` — validation, lifecycle, tenancy, execution, baselines,
  CI and concurrency suites; `tests/e2e/phase15-studio.e2e.test.ts` for the
  real-Docker journey.
