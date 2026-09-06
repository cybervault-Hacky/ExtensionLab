# Plans and entitlements

ExtensionLab has exactly three plans: **Free**, **Pro** and **Business**.
Every limit the product enforces comes from one configuration-driven catalog
(`lib/billing/plans.ts` + `lib/billing/config.ts`); the public pricing page,
the billing dashboard and the entitlement checks all read the same object, so
they cannot drift apart.

## Defaults

| Setting | Free | Pro | Business |
| --- | --- | --- | --- |
| Analyses per period | 10 | 200 | 1000 |
| Automated test runs per period | 5 | 100 | 500 |
| Max extension size | 25 MB | 25 MB | 25 MB |
| Concurrent test runs | 1 | 2 | 4 |
| History retention | 30 days | 180 days | 365 days |
| Artifact retention (screenshots, logs) | 7 days | 30 days | 90 days |
| Package retention (uploaded ZIPs) | 14 days | 60 days | 180 days |
| Report sharing | expiring links up to 7 days | permanent or expiring | permanent or expiring |
| Advanced diagnostics (runtime logs, network evidence) | – | ✓ | ✓ |
| Priority queue | – | – | ✓ |
| AI assistance requests per period (Phase 8) | not included | 100 | 500 |
| Cross-browser testing (Phase 9) | – | ✓ | ✓ |
| Browsers per matrix run | 1 (Chromium only) | 3 | 3 |
| Browser concurrency | 1 | 2 | 3 |
| Regression testing / baselines (Phase 9) | – | ✓ | ✓ |
| Advanced test suites — `service-worker`, `permission-smoke` (Phase 9) | – | ✓ | ✓ |
| Interactive browser sessions per period (Phase 11) | 5 | 60 | 300 |
| Interactive browser: concurrent live sessions | 1 | 2 | 4 |
| Interactive browser: max session length | 10 min | 30 min | 60 min |

"Period" is the calendar month for Free users and the **subscription billing
period** (`currentPeriodStart` → `currentPeriodEnd`) for paid users; usage
resets when the period rolls over (see [BILLING.md](BILLING.md#usage-periods)).

Prices are **not** hardcoded. They are display values read from
`BILLING_PRO_AMOUNT` / `BILLING_BUSINESS_AMOUNT` (minor units) and
`BILLING_CURRENCY`; the amount actually charged is whatever the provider
price object (`BILLING_PRO_PRICE_ID`, `BILLING_BUSINESS_PRICE_ID`) says. A
paid plan without a configured price id is shown but marked *not purchasable*
("Contact us").

## Configuration

Each field can be overridden per plan with `PLAN_<FREE|PRO|BUSINESS>_<SETTING>`:

```
PLAN_PRO_ANALYSIS_LIMIT=200
PLAN_PRO_TEST_LIMIT=100
PLAN_PRO_MAX_EXTENSION_SIZE=26214400
PLAN_PRO_MAX_CONCURRENT_RUNS=2
PLAN_PRO_HISTORY_RETENTION_DAYS=180
PLAN_PRO_ARTIFACT_RETENTION_DAYS=30
PLAN_PRO_PACKAGE_RETENTION_DAYS=60
PLAN_PRO_AI_ENABLED=true
PLAN_PRO_AI_LIMIT=100
PLAN_PRO_CROSS_BROWSER=true
PLAN_PRO_MAX_BROWSERS=3
PLAN_PRO_BROWSER_CONCURRENCY=2
PLAN_PRO_REGRESSION_TESTING=true
PLAN_PRO_ADVANCED_SUITES=true
```

Phase 9 notes:

- **Cross-browser entitlements** (`crossBrowserEnabled`, `maxBrowsersPerRun`,
  `browserConcurrency`, `regressionTesting`, `advancedSuites`) are read only
  by the entitlement service — there is no `if plan === "pro"` anywhere, so
  operators can reshape tiers via configuration without code changes.
- `maxBrowsersPerRun` is additionally capped by the deployment-wide
  `MAX_BROWSERS_PER_MATRIX` (default 3).
- **Matrix quota policy (documented, deterministic):** one test-run unit per
  browser execution — a suite × 3 browsers consumes 3 of the plan's
  "automated test runs per period". Chromium-only runs stay available on
  Free. See [BROWSERS.md](BROWSERS.md#quota-policy-deterministic-and-documented).

AI assistance is the one feature flag that *is* environment-configurable
(`PLAN_<PLAN>_AI_ENABLED`, `PLAN_<PLAN>_AI_LIMIT`), because operators may
enable a small Free allowance or disable AI for a plan without a release.
Free defaults to `false` / `0`.

The Phase 5 variables (`PLAN_ANALYSIS_LIMIT`, `PLAN_TEST_LIMIT`,
`PLAN_MAX_EXTENSION_SIZE`, `PLAN_MAX_CONCURRENT_RUNS`,
`PLAN_HISTORY_RETENTION_DAYS`) and the Phase 6 global
`ARTIFACT_RETENTION_DAYS` / `PACKAGE_RETENTION_DAYS` keep working and apply to
the **Free** plan only. `PLAN_MAX_EXTENSION_SIZE` is still capped by the
analyzer's hard limit.

Feature flags (`sharingEnabled`, `shareMaxExpiryHours`, `advancedDiagnostics`,
`priorityExecution`) are part of the catalog definition rather than the
environment: changing them is a product decision and a code change.

## Plan object

```ts
interface Plan {
  id: "free" | "pro" | "business";
  name: string;
  description: string;
  audience: string;
  price: { amount: number | null; currency: string; interval: "month" };
  purchasable: boolean;          // paid plan with a configured price id
  rank: number;                  // 0 free, 1 pro, 2 business (ordering + "requiredPlan")
  analysisLimit: number;
  testRunLimit: number;
  maxExtensionSize: number;      // bytes
  maxConcurrentRuns: number;
  historyRetentionDays: number;
  artifactRetentionDays: number;
  packageRetentionDays: number;
  sharingEnabled: boolean;
  shareMaxExpiryHours: number;   // 0 = permanent links allowed
  advancedDiagnostics: boolean;
  priorityExecution: boolean;
  aiEnabled: boolean;            // Phase 8: AI assistance included
  aiRequestLimit: number;        // AI requests per period (0 = none)
  highlights: string[];          // marketing bullets (derived, not authoritative)
}
```

The browser only ever receives `PlanView` (the same fields minus nothing
secret — there is nothing secret in a plan) via `GET /api/billing/plans` and
`GET /api/me`. Price ids and provider identifiers are never sent to clients.

## Entitlement service

`lib/billing/entitlements.ts` is the single authority. Every product API calls
it **after** authenticating the user and **before** doing work:

| Function | Used by |
| --- | --- |
| `getEffectivePlan(userId)` | everything (`plan`, `state`, `paid`, `paidUntil`, `graceUntil`) |
| `canAnalyze(userId)` | `POST /api/extensions` |
| `canRunTests(userId)` | `createQueuedTestRun` (`POST /api/tests/create`), `POST /api/sandbox/create` |
| `canUploadPackage(userId, size)` | package storage (`lib/packages/service.ts`) |
| `canCreateShare(userId, hours)` | `POST /api/reports/:id/share` |
| `canUseAdvancedDiagnostics(userId)` | non-screenshot artifacts (`/api/artifacts/:id`, persistence) |
| `getMaxConcurrentRuns(userId)` | run creation and the worker's per-user cap |
| `hasPriorityExecution(userId)` | job priority when enqueuing automated tests |
| `getRetentionForUser(userId)` | artifact expiry, package cleanup, history |
| `getQuotaUsage(userId, kind)` | quota snapshots, `/api/me`, billing dashboard |
| `canUseAI(userId)` | every `POST /api/ai/*` route (plan gate) and `runAIFeature` (period quota, usage kind `ai_request`) |

Results are `EntitlementResult` objects (`{ allowed: true }` or
`{ allowed: false, reason: "quota" | "plan" | "size", requiredPlan, … }`) and
`assertEntitled()` in `lib/auth/api.ts` maps them to the HTTP contract:

| Reason | Status | `errorCode` | `details` |
| --- | --- | --- | --- |
| quota | 429 | `QUOTA_EXCEEDED` (`AI_QUOTA_EXCEEDED` for `ai_request`) | `kind, currentUsage, limit, resetAt, plan, requiredPlan, requiredPlanName` |
| plan | 402 | `PAYMENT_REQUIRED` | `plan, requiredPlan, requiredPlanName` |
| size | 413 | `PAYMENT_REQUIRED` | `maxExtensionSize, plan, requiredPlan, requiredPlanName` |

The frontend renders these through `components/billing/PaywallNotice.tsx`
("… [View plans]"). It never decides on its own whether something is allowed;
hiding a button is a courtesy, the server check is the rule.

## Effective plan and subscription state

`resolveEffectivePlan(subscriptionRow, now)` turns the stored provider state
into a `BillingStateKind`:

| State | Paid features | When |
| --- | --- | --- |
| `free` | no | no subscription |
| `active` | yes | provider says active, period running |
| `trialing` | yes | trial not yet ended |
| `cancel_scheduled` | yes (until period end) | `cancelAtPeriodEnd = true` |
| `past_due_grace` | yes | renewal failed (or renewal event late); within `BILLING_PAST_DUE_GRACE_DAYS` (default 7) after the period end |
| `past_due` | no | grace elapsed |
| `cancelled` | no | provider cancelled / period ended after cancel |
| `expired` | no | trial ended, unpaid, incomplete_expired, period ended without renewal |
| `incomplete` | no | first payment never succeeded (also any unknown provider status) |
| `paused` | no | provider paused collection |

Unknown provider statuses never entitle anyone. Losing paid status never
deletes data: history and artifacts simply age out under the Free retention
from then on, and the next cleanup uses the owner's *current* plan.

## Usage accounting rules

- Quota is **reserved** in the same transaction that creates a test run,
  **consumed** when the sandbox actually starts, and **released** when a run is
  cancelled while queued, fails before execution (infrastructure error) or is
  swept as stale. Analyses are recorded when the analysis is accepted.
- Requests that fail validation never consume usage.
- `currentUsage` in a 429 body is `used + reserved` for the current period.
- Upgrading applies immediately (the next request sees the new limits);
  downgrading applies at the boundary the provider reports.

## Interactive browser notes (Phase 11)

Interactive sessions reuse the same reserve → consume → release accounting as
test runs: the per-period unit is **reserved** at session creation, **consumed**
when the browser actually reaches READY, and **released** when a session is
stopped before it started. Capacity (concurrent live sessions) is queue
backpressure, not a quota: an over-capacity start stays QUEUED and retries as
slots free. The hard lifetime ceiling never moves for keepalives. Deployment
caps (`INTERACTIVE_BROWSER_MAX_GLOBAL` / `_PER_ORG`) apply above plan limits.

## Adding or changing a plan

Do not add a fourth plan; annual billing would be a second `price` on the same
plan id (the data model already keys subscriptions by provider price id).
Changing a limit is an environment change; changing a feature flag is a one
line edit in `lib/billing/plans.ts` covered by `tests/phase7/plans-entitlements.test.ts`.

## Organization plans (Phase 10)

Organizations extend the same plan philosophy server-side. Defaults:
Free (2 members, no API/webhooks/SSO/export, concurrency 2), Pro (10 members,
API + webhooks + advanced audit + export + CI gates + advanced matrix,
concurrency 4), Business (50 members, + SSO + high concurrency, 180-day
retention, concurrency 8). Deployments override with `ORG_PLAN_<PLAN>_<KEY>`
exactly like personal plans; concurrency is finally clamped by
`ORG_MAX_CONCURRENCY`. Seat counts are provisioned values — billing changes
them through the provider abstraction, and where a provider cannot update
seats automatically an operator applies the change (documented limitation).
