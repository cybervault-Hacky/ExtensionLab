# Browsers and cross-browser testing (Phase 9)

ExtensionLab tests extensions across **Chromium, Microsoft Edge and Firefox**.
There is deliberately no Safari support (see the Phase 9 scope: no
iOS/macOS-only engines, no real devices, no mobile farms).

The multi-browser support is **not** a copy of the runtime per browser. The
Phase 4 test engine, evidence collection, scoring and diagnostics stay central
and unchanged; each browser only plugs in a small
**BrowserRuntimeAdapter** (`sandbox/runner/browsers/`) that knows how to start
that browser, load the extension into it and speak its automation protocol:

| Browser | Adapter | Protocol | Extension loading | Engine |
| --- | --- | --- | --- | --- |
| `chromium` | `sandbox/runner/browsers/chromium.ts` | CDP (`--remote-debugging-port=9222`) | `--load-extension` command-line flag | Chromium |
| `edge` | `sandbox/runner/browsers/chromium.ts` (same adapter, `microsoft-edge` executable) | CDP | `--load-extension` command-line flag | **Chromium engine (Edge)** — Edge is Chromium-compatible, not an independent engine |
| `firefox` | `sandbox/runner/browsers/firefox.ts` | geckodriver on `:9515` + WebDriver BiDi | `temporary install add-on` API | Gecko |

Which browser a container runs is decided **only** by the `EXTENSIONLAB_BROWSER`
environment variable set by the server-side Docker driver (a validated id:
`chromium | edge | firefox`). Nothing browser-specific is ever taken from user
input: no arbitrary browser flags, no JS, no `eval`, no console commands, no
raw CDP passthrough, no shell access. Firefox never pretends to speak CDP — it
uses its own protocol adapter with the same fixed, reviewed command surface.

## Deployment: images and versions

Each browser runs from its **own pinned image** with identical hardening (see
[SECURITY.md](SECURITY.md)); Edge never implicitly reuses the Chromium
executable, and Firefox never reuses a Chromium image.

```bash
npm run sandbox:build          # legacy single (Chromium) image — still supported
npm run sandbox:build:chromium # dedicated Chromium image
npm run sandbox:build:edge     # dedicated Edge image
npm run sandbox:build:firefox  # dedicated Firefox image
npm run sandbox:build:matrix   # all three dedicated images
```

Image and version resolution (server-internal, never exposed through the API):

| Variable | Meaning | Default |
| --- | --- | --- |
| `SANDBOX_IMAGE_CHROMIUM` | Image for the `chromium` runtime | falls back to the legacy `SANDBOX_IMAGE` (`extensionlab-sandbox:local`) |
| `SANDBOX_IMAGE_EDGE` | Image for the `edge` runtime | `extensionlab-sandbox-edge:local` |
| `SANDBOX_IMAGE_FIREFOX` | Image for the `firefox` runtime | `extensionlab-sandbox-firefox:local` |
| `BROWSER_CHROMIUM_VERSION` / `BROWSER_EDGE_VERSION` / `BROWSER_FIREFOX_VERSION` | Version label recorded in listings and reports (e.g. image tag) | `bundled` |
| `BROWSER_CHROMIUM_EXECUTABLE` / `BROWSER_EDGE_EXECUTABLE` / `BROWSER_FIREFOX_EXECUTABLE` | Executable inside the container | `chromium` / `microsoft-edge` / `firefox` |
| `BROWSER_<ID>_ENABLED` | Disable a runtime without rebuilding (`0`/`true`/`1`) | enabled |

The version *label* comes from deployment configuration; the **exact version of
the browser that actually executed a run is recorded per run** from the runtime
itself (CDP `Browser.getVersion` for Chromium-family, geckodriver capabilities
for Firefox) and stored on `test_runs.browser_version` and on each matrix
execution. Public browser metadata (versions, capabilities) always reflects
what this deployment actually has pinned — no invented version claims.

Matrix limits (all bounded server-side):

| Variable | Default | Bounds |
| --- | --- | --- |
| `MAX_BROWSERS_PER_MATRIX` | 3 | 1–3 |
| `MAX_MATRIX_TESTS` | 32 | — |
| `MAX_MATRIX_CONCURRENCY` | 2 | — |
| `MAX_MATRIX_ARTIFACTS` | 24 | — |
| `MATRIX_TIMEOUT_MS` | 8 min | 30 s – 1 h |
| `MATRIX_BROWSER_TIMEOUT_MS` | 150 s | 10 s – 30 min |

## Capability model and gating

`lib/browsers/capabilities.ts` defines per-browser capabilities with four
support levels: `supported`, `partial`, `unsupported`, `version-dependent`.
The deterministic rules:

- An assertion or action that requires an `unsupported` capability is
  **SKIPPED with `UNSUPPORTED` reason — never FAILED**. A skipped test never
  reduces a score.
- `partial` and `version-dependent` capabilities run normally; differences
  surface as comparison findings, not verdicts.
- Capability parity: Edge intentionally mirrors Chromium's capabilities
  (same engine); Firefox differs where documented, e.g.:
  - `extensionManifestV2`: `version-dependent` on Chromium-family (phase-out
    depends on the pinned version), `supported` on Firefox.
  - `serviceWorker` on Firefox: `partial` — Firefox implements MV3 background
    execution as a non-persistent **event page**, so the MV3 service-worker
    lifecycle test is statically skipped on Firefox and a
    `BACKGROUND_MODEL_DIFFERENCE` note explains why.
  - `networkStatusCodes` on Firefox: `unsupported` — response-status network
    assertions skip on Firefox instead of failing.

`GET /api/browsers` lists browsers (id, name, engine, engine label, version,
availability + stable reason code, capabilities).
`GET /api/browsers/capabilities` additionally exposes the exact deterministic
gates the engine uses. Both are authenticated and sanitized: **no image names,
executables, container paths, hosts or Docker details are ever returned.**

## Matrix runs

`POST /api/tests/matrix` accepts either a multipart upload (file + `browsers`
CSV + optional `suiteId`, `testUrl`, `extensionId`) or JSON `{ packageId }`
(reusing a stored, hash-verified package). Creation is one atomic transaction:
matrix row → one child `test_run` + job + quota reservation **per browser** →
`browser_matrix_executions` rows.

- Each child execution gets its **own disposable container, browser state,
  artifacts, event stream and timeout** — no state leaks between browsers.
- Idempotency: child jobs use idempotency keys `matrix:<id>:<browser>`;
  completion callbacks and finalization are idempotent (re-firing never
  duplicates the report).
- Parent statuses: `queued → running → completed | partial | failed |
  cancelled`. **`partial`** means at least one browser produced real results
  and at least one failed or was unavailable. All-cancelled → `cancelled`;
  nothing executed at all → `failed`.
- Availability is probed **before** scheduling: if a pinned image is missing,
  creation fails with `BROWSER_RUNTIME_UNAVAILABLE` (HTTP 503) and nothing is
  created or charged.
- `GET /api/tests/matrix/[runId]` returns the full view (owner-only);
  `POST .../cancel` cancels queued/running children while preserving finished
  results; `GET .../events/stream` streams progress over SSE.
- Stale matrices are swept (`matrix-sweep` cleanup job + read-path sweep):
  after `MATRIX_TIMEOUT_MS` grace they are cancelled and finalized honestly.

### Extension failure vs infrastructure failure

A browser container that never ran (image missing, container down, startup
failure) is classified `INFRASTRUCTURE_ERROR` and the execution is marked
`skipped`. It is **never** counted as an extension failure:

- the compatibility score excludes it from the denominator (score of the
  browsers that actually executed),
- coverage drops (`executed / requested`) and the browser appears under
  `browsersUnavailable`,
- an `INFRASTRUCTURE_UNAVAILABLE` finding states that the data is
  insufficient — the UI shows *"Infrastructure failure — no extension verdict"*.

Failure classification on child runs follows the existing outcome codes
(`PASSED | WARNING | FAILED | TIMEOUT | SKIPPED | EXTENSION_LOAD_FAILED |
INFRASTRUCTURE_ERROR | CANCELLED`). Retry policy is unchanged: **only
infrastructure failures are retried**, never extension failures.

## Quota policy (deterministic and documented)

**One test-run unit per browser execution.** A suite × 3 browsers = **3
browser executions = 3 test-run units** — never silently multiplied
(sub-tests don't count) and never undercounted (a browser that was skipped for
infrastructure reasons releases its reservation). The whole matrix (rows +
reservations + jobs) is created in one transaction; a matrix that cannot be
fully reserved is rejected with `QUOTA_EXCEEDED` and leaves nothing behind.
Client-supplied quota or concurrency values are never trusted.

## Comparison, scoring and findings

`lib/testing/comparison.ts` computes a deterministic `CrossBrowserResult`:

- **Score** = `round(100 × passing-browsers / executed-browsers)` where a
  passing browser has outcome `PASSED` or `WARNING`. `null` (with zero
  coverage) when nothing executed — *"insufficient data"*, not a fake score.
- **Coverage** = executed / requested browsers.
- Per-test matrix with a `differs` flag (status disagreement across browsers).
- **Findings are evidence-based only**: `BROWSER_ONLY_FAILURE`,
  `UNSUPPORTED_FEATURE`, `MANIFEST_COMPATIBILITY_WARNING`,
  `BACKGROUND_MODEL_DIFFERENCE`, `POPUP_BEHAVIOR_DIFFERENCE`,
  `NETWORK_STATUS_DIFFERENCE`, `CONSOLE_DIFFERENCE`,
  `RUNTIME_ERROR_BROWSER_SPECIFIC`, `INFRASTRUCTURE_UNAVAILABLE`. Every
  finding cites recorded evidence; wording is neutral
  (*"Browser-specific failure detected"*) — the platform never claims a root
  cause or blames a browser vendor.
- **Side-by-side screenshots** per browser (stored as run artifacts; no AI
  image interpretation of any kind).
- **Redacted network comparison** (method, sanitized URL, status per browser)
  and **console/runtime error comparison** grouped by normalized signature
  (hex ids → `[id]`, numbers → `[n]`, quoted strings → `"…"`) into *common*
  vs *browser-specific* groups.

The comparison is written once into an immutable cross-browser report
(`kind: "cross-browser-matrix"`), referenced from the matrix run.

## Baselines and regression comparison

`POST /api/baselines` designates a finished matrix run (or single run) as the
extension's baseline — pinning the exact package version, snapshot, suite and
browser configuration. `POST /api/regressions/compare` compares a current
run/matrix against either an explicitly provided previous side **or the
extension's designated baseline** (409 `CONFLICT` if none exists; "latest" is
never guessed). Rules (deterministic):

- `PASS/ WARNING → FAILED | ERROR | TIMEOUT` = regression,
- `PASS → SKIPPED` (capability loss) = regression,
- `FAIL → PASS` = improvement,
- **`FAIL → FAIL` is never reported as a new regression**,
- new runtime errors (by normalized signature) and new 4xx/5xx endpoints
  (method + URL) are listed,
- per-browser reports aggregate into counts, average score delta and
  `browserSpecificRegressions`.

Regression testing requires the `regressionTesting` entitlement.

## Entitlements (billing service only)

New entitlements — enforced server-side via the entitlement service, never via
plan-name checks:

| Entitlement | Free | Pro | Business |
| --- | --- | --- | --- |
| `crossBrowserEnabled` | – | ✓ | ✓ |
| `maxBrowsersPerRun` | 1 | 3 | 3 (cap: deployment limit) |
| `browserConcurrency` | 1 | 2 | 3 |
| `regressionTesting` | – | ✓ | ✓ |
| `advancedSuites` (`service-worker`, `permission-smoke`) | – | ✓ | ✓ |

Chromium-only runs remain available on the free plan. See
[PLANS.md](PLANS.md).

## Static compatibility analysis

Alongside runtime testing, the analyzer (Phase 1/2, never executing code)
produces **informational** browser-compatibility notes
(`lib/extension/browser-compat.ts`): manifest-version phase-out timelines, the
Firefox MV3 event-page model, Chromium-only permissions (`offscreen`,
`sidePanel`), partial permissions (`declarativeNetRequest`),
`chrome.*`/`browser.*` namespace usage with file evidence, polyfill detection
and missing `browser_specific_settings.gecko`. These notes are advisory
("review"), never a verdict — only real executions decide pass/fail.

## APIs

| Endpoint | Method | Notes |
| --- | --- | --- |
| `/api/browsers` | GET | Authenticated; sanitized browser list + availability |
| `/api/browsers/capabilities` | GET | + deterministic engine gates |
| `/api/tests/matrix` | POST/GET | Same-origin, rate-limited, authenticated; multipart or `{packageId}`; list is owner-scoped |
| `/api/tests/matrix/[runId]` | GET | Owner-scoped full view (executions, comparison) |
| `/api/tests/matrix/[runId]/cancel` | POST | Cooperative cancel, finished results preserved |
| `/api/tests/matrix/[runId]/events/stream` | GET | SSE progress (1 s poll, 15 s heartbeat, bounded lifetime) |
| `/api/reports/compare?matrix=` | GET | Comparison view for a matrix run |
| `/api/regressions/compare` | POST/GET | Baseline auto-resolution; owner-scoped results |
| `/api/baselines` | GET/POST/DELETE | Designate/manage the extension baseline |

`/api/tests` supports `browserId` and `matrixRunId` filters. Every private
endpoint enforces session auth, ownership, entitlement, schema and quota; the
public/shared report projection keeps browser metadata only (no
infrastructure).

## Verification

Unit tests: `tests/phase9/` (browser registry/capabilities, gating, templates
and dependency validation, suites, comparison, regression rules, matrix
service, browser-compat static analysis, API routes, per-browser container
hardening, public sanitization).

Real-Docker E2E: `tests/e2e/cross-browser.e2e.test.ts` (matrix across built
images, missing-image fail-closed, quota atomicity, billing gate + cancel,
regression A/B with two package versions). Without Docker the suites **skip
with an explicit reason**; with `EXTENSIONLAB_E2E_DOCKER=1` a missing daemon
or missing image is a **hard failure** — browser results are never faked.

## Phase 13: image identity & health

- Execution identity is an **image digest** (recorded per session), never a
  mutable `latest` tag; unverifiable digests surface as `unknown` — they are
  never fabricated.
- Container start waits on the container-local health check before a session
  is declared READY.
- Resource profiles: `standard` (768m/0.5 CPU) and `heavy` (1536m/1.0 CPU, plan
  entitlement) on the same hardened baseline — see [RUNTIME.md](RUNTIME.md).
