# Billing

Phase 7 turns ExtensionLab into a subscription product:
Free → paid plan → hosted checkout → provider subscription → webhook →
entitlements → usage limits → billing portal → invoices. Billing is a
separate module (`lib/billing/`) that the rest of the app talks to only through
the entitlement service; the payment provider is behind one interface and can
be swapped without touching product code.

Plans and limits are documented in [PLANS.md](PLANS.md).

## Architecture

```
browser ── POST /api/billing/checkout {planId} ──▶ billing-service ──▶ provider (hosted checkout)
                                                            │
provider ── POST /api/billing/webhook (signed) ─────────────┤ verify → ledger → subscriptions table
                                                            │
product APIs ── entitlements.ts ── subscriptions + usage ───┘ → allow / 429 / 402 / 413
```

| Module | Responsibility |
| --- | --- |
| `lib/billing/types.ts` | Plan, subscription, event and provider interfaces |
| `lib/billing/plans.ts`, `config.ts` | Plan catalog (env-overridable), plan ↔ price id mapping |
| `lib/billing/entitlements.ts` | Effective plan, state machine, usage periods, `can*` checks |
| `lib/billing/billing-service.ts` | Checkout, confirm, portal, cancel, reactivate, invoices, state view |
| `lib/billing/subscriptions.ts` | Applies provider subscription snapshots to the local table, audit + metrics |
| `lib/billing/webhooks.ts` | Signature verification entry point, idempotent event processing |
| `lib/billing/provider.ts` | Provider selection from config (`stripe` / `fake` / `disabled`) |
| `lib/billing/providers/stripe.ts` | Stripe REST adapter (fetch, no SDK, API version `2024-06-20`) |
| `lib/billing/providers/fake.ts` | In-memory provider for development and tests (rejected in production) |
| `lib/billing/providers/signature.ts` | HMAC-SHA256 `t=…,v1=…` signing/verification with tolerance |
| `lib/billing/providers/stripe-normalize.ts` | Stripe objects → internal `ProviderEvent`/`ProviderSubscription` |
| `lib/db/repositories/billing.ts` | `billing_customers`, `subscriptions`, `billing_events`, `checkout_sessions` |
| `lib/db/migrations/003_phase7_billing.sql` | Schema |

Nothing outside `lib/billing/` imports a provider. Product routes import
`entitlements.ts` (and `assertEntitled` from `lib/auth/api.ts`) only.

## Data model (migration 003)

- `billing_customers (user_id, provider, provider_customer_id)` — one
  provider customer per user; unique on `(provider, provider_customer_id)`.
- `subscriptions (id, user_id, provider, provider_customer_id,
  provider_subscription_id, provider_price_id, plan_id, status,
  current_period_start, current_period_end, cancel_at_period_end, cancel_at,
  canceled_at, trial_end, ended_at, last_event_at, created_at, updated_at)` —
  the provider's view, normalized. Unique on `(provider, provider_subscription_id)`.
  `last_event_at` makes out-of-order webhooks harmless: an event older than
  the stored state (compared at one-second granularity, the provider's
  resolution) is ignored.
- `billing_events (id, provider, provider_event_id, event_type,
  provider_event_type, user_id, subscription_id, result, created_at,
  processed_at)` — the
  idempotency ledger. Unique on `(provider, provider_event_id)`: a redelivered
  event is answered `200 {outcome:"duplicate"}` without touching state; an
  event whose processing failed is re-openable so the provider's retry can
  succeed.
- `checkout_sessions (user_id, provider, provider_session_id, plan_id,
  status)` — ownership of checkout sessions for the return-page confirmation.
- Existing `usage_events` and `quota_reservations` tables are reused
  unchanged (indexes added for period queries). There is no second usage
  model.

Card numbers, payment methods and provider payloads are never stored.
Invoices are fetched live from the provider (hosted URLs) and not mirrored.

## Configuration

```
BILLING_PROVIDER=stripe | fake | disabled   # default: fake in dev/test, disabled in production
BILLING_SECRET_KEY=                          # provider secret / restricted key
BILLING_WEBHOOK_SECRET=                      # webhook signing secret
BILLING_PRO_PRICE_ID=price_…                 # provider price for Pro
BILLING_BUSINESS_PRICE_ID=price_…            # provider price for Business
BILLING_CURRENCY=inr                         # display currency
BILLING_PRO_AMOUNT=79900                     # display amount, minor units
BILLING_BUSINESS_AMOUNT=249900
BILLING_PAST_DUE_GRACE_DAYS=7
BILLING_DELETION_POLICY=cancel_immediately | cancel_at_period_end
BILLING_FAKE_WEBHOOK_SECRET=                 # fake provider only
APP_URL=https://…                            # success/cancel/return URLs are built from this
RATE_LIMIT_BILLING_READ_PER_MIN=60
RATE_LIMIT_BILLING_CHECKOUT_PER_MIN=5
RATE_LIMIT_BILLING_PORTAL_PER_MIN=5
RATE_LIMIT_BILLING_CHANGE_PER_MIN=10
RATE_LIMIT_BILLING_WEBHOOK_PER_MIN=600
```

Validation (`lib/config/env.ts`, evaluated once at startup):

- `stripe` requires `BILLING_SECRET_KEY`, `BILLING_WEBHOOK_SECRET` and at
  least one price id; in production the key must be a live key
  (`sk_live_…` / `rk_live_…`).
- `fake` and `BILLING_FAKE_WEBHOOK_SECRET` are rejected in production.
- `disabled` keeps every user on Free; `/api/billing/*` answers
  `503 BILLING_NOT_CONFIGURED` (webhook: 404) and the UI hides purchase
  actions.
- Misconfiguration is a startup `ConfigError` with the variable name, never a
  runtime surprise. `describeConfig()` logs `billing.provider` and which price
  ids are present — never the values.

Secrets live in the environment only. `.env.example` contains placeholders,
`.env*` is git-ignored, the Stripe adapter puts the key in the `Authorization`
header exclusively and never logs responses, and
`tests/phase7/product-entitlements.test.ts` fails if a client component
references a secret variable or imports a server billing module.

## Lifecycle

### Checkout

1. `POST /api/billing/checkout {planId}` (session + same-origin check +
   `billingCheckout` rate limit). The body names a plan, nothing else — any
   `priceId`, `amount` or `currency` sent by the browser is ignored; the
   server maps `planId → BILLING_<PLAN>_PRICE_ID`.
2. A provider customer is created once per user and stored.
3. A hosted checkout session is created (`mode=subscription`, metadata
   `userId`/`planId`, idempotency key derived from user + plan + 10-minute
   window so double clicks reuse the same session). The local
   `checkout_sessions` row records ownership; audit `checkout_started`.
4. Response `{url}`; the browser navigates to the provider.
5. Success URL: `/dashboard/billing/return?session_id={CHECKOUT_SESSION_ID}`;
   cancel URL: `/dashboard/billing?checkout=cancelled`.

Users who already have a paid subscription cannot start a second checkout
(`409 SUBSCRIPTION_STATE_INVALID`); plan changes go through the hosted portal
(proration and payment method live there).

### Activation (webhook-first)

The return page shows "Your payment is being confirmed" and polls
`POST /api/billing/confirm {sessionId}`. Confirmation only consults the
provider about a session **this user created**; a session id in a URL grants
nothing by itself, and a session owned by another account answers
`status: "unknown"`. Both the webhook and the confirm path feed the same
writer (`applyProviderSubscription`), so whichever arrives first wins and the
other is a no-op. Entitlements come exclusively from **subscription
objects**: `checkout.session.completed` alone never upgrades anyone.

### Webhook

`POST /api/billing/webhook` — no session, no CSRF (the sender is not a
browser); authenticity comes from the signature over the **raw body**.

| Response | Meaning |
| --- | --- |
| `200 {outcome: processed \| duplicate \| ignored}` | do not retry |
| `400 WEBHOOK_SIGNATURE_INVALID` | missing / wrong-secret / tampered / stale (> 300 s) signature or malformed JSON |
| `413` | body over 1 MB |
| `429` + `retry-after` | rate limit (`RATE_LIMIT_BILLING_WEBHOOK_PER_MIN`, default 600) |
| `500 INTERNAL` | transient failure while applying — provider retries; the ledger keeps application at-most-once |
| `404` | billing disabled |

Handled events: `checkout.session.completed`, `customer.subscription.created
/ updated / deleted`, `invoice.paid`, `invoice.payment_failed`. Everything
else is acknowledged as `ignored`. Events for unknown or deleted users are
acknowledged as `ignored` (no retries). Responses never contain stack traces
or provider payloads.

### Renewal, payment failure, grace

- `invoice.paid` with the subscription's new period updates
  `current_period_start/end`; usage for paid users is counted inside that
  window, so the quota effectively resets at renewal.
- `invoice.payment_failed` → audit `payment_failed`, metric
  `billing.payment_failed`; the subscription usually becomes `past_due`.
  Paid features stay on for `BILLING_PAST_DUE_GRACE_DAYS` after the missed
  period end (`past_due_grace`, dashboard shows "Payment issue" with a link to
  the portal), then drop to Free (`past_due`) until the provider reports
  recovery.
- If no renewal event arrives after the period end (webhook outage), the same
  grace applies before access is treated as expired.

### Cancellation and reactivation

- `POST /api/billing/cancel` → provider `cancel_at_period_end`; state
  `cancel_scheduled` ("Cancels on DATE"); paid features continue until the
  period end; audit `subscription_cancelled`.
- `POST /api/billing/reactivate` clears the scheduled cancellation while the
  period is still running; audit `subscription_reactivated`.
- When the period ends the provider sends `customer.subscription.deleted` →
  `cancelled`, Free entitlements, nothing deleted.

### Portal and invoices

- `POST /api/billing/portal` → hosted portal URL (payment method, plan
  change, tax details, invoices).
- `GET /api/billing/invoices` → the user's own invoices with provider-hosted
  URLs (`amount`, `currency`, `status`, `date`, `period`), never another
  customer's.

### Account deletion

`deleteAccount()` cancels open subscriptions **at the provider first**
(`BILLING_DELETION_POLICY`: `cancel_immediately` by default, or
`cancel_at_period_end`), then deletes the account in one transaction. If the
provider call fails the deletion is aborted with a retryable
`BILLING_PROVIDER_ERROR` so no one keeps being charged for a deleted account.
With billing disabled and stale local subscriptions the deletion logs a warning
and proceeds. Provider-side customer records are retained for the provider's
own accounting/tax obligations.

## Usage periods

`getUsagePeriod(effectivePlan)`:

- paid (`active`, `trialing`, `cancel_scheduled`, `past_due_grace`) →
  `[currentPeriodStart, currentPeriodEnd)` from the subscription; during grace
  the window extends to the grace end so users are not double-counted;
- otherwise → calendar month in server time.

Usage made before a subscription started is outside the paid window by
design (the customer paid for a fresh allowance). `resetAt` in quota errors
and `/api/me` is the end of the current period.

## Security summary

- All `/api/billing/*` routes except the webhook require a session and a
  same-origin request (`requireSameOrigin`), and are rate limited per user+IP.
- The client never sends prices, currencies, plan states or entitlements;
  the server derives everything from its own subscription table.
- No "set plan" API exists anywhere; the only writers of `subscriptions` are
  the webhook processor and the owner-checked confirm path, both fed by
  provider objects.
- Responses expose derived state only (`BillingStateView`): no provider
  customer/subscription ids, no raw statuses, no secrets.
- Audit events (`audit_events`): `checkout_started`,
  `subscription_created/activated/changed/cancelled/reactivated`,
  `payment_succeeded`, `payment_failed` — amounts only, never instruments.
- Metrics: `billing.checkout_attempt/failed`, `billing.webhook_received/
  processed/duplicate/rejected/failed/rate_limited`,
  `billing.subscription_changed`, `billing.payment_succeeded/failed`,
  `billing.cancellation`, `billing.reactivation`, `billing.provider_error`,
  `billing.portal_failed`.
- Logs carry `requestId`, `userId`, `planId`, `provider`, `errorCode`,
  `durationMs`, `result`; never bodies, keys or signatures.

## Local development and testing

The fake provider is the default outside production:

```
BILLING_PROVIDER=fake
BILLING_PRO_PRICE_ID=price_pro_dev
BILLING_BUSINESS_PRICE_ID=price_business_dev
BILLING_PRO_AMOUNT=79900
BILLING_BUSINESS_AMOUNT=249900
```

Its checkout "page" is the app's own return page, so clicking *Upgrade* lands
on "payment is being confirmed"; the subscription is only created when a
**signed** fake event is posted to the real webhook route — exactly what the
tests do (`tests/phase7/helpers.ts → deliver()`), which keeps the production
activation path exercised. Test helpers on the instance
(`provider.fake.completeCheckout / invoice / updateSubscription / expire /
failNext / sign`) drive every lifecycle transition.

Test suites (`npm run test`):

- `tests/phase7/plans-entitlements.test.ts` — catalog/env overrides,
  production config rules, state machine (free/pro/trial/expired/cancelled/
  past_due grace/paused/unknown), usage periods, size and share gates.
- `tests/phase7/billing-lifecycle.test.ts` — checkout → webhook → Pro,
  duplicate webhook applied once, tampered/unsigned/stale signatures rejected,
  cancel/reactivate/expire, past-due grace and recovery, period reset,
  invoice isolation, provider failure handling, portal, account deletion.
- `tests/phase7/signature-and-provider.test.ts` — signing primitive, Stripe
  normalizer, Stripe REST adapter (mocked `fetch`: form encoding, auth header,
  idempotency key, error mapping).
- `tests/phase7/product-entitlements.test.ts` — 429/402 contracts on product
  APIs, quota race, concurrency/priority per plan, share gating, immediate
  upgrade, client bundle hygiene.

Real-provider (Stripe test mode) end-to-end runs are a manual step; see below.

## Production setup (Stripe)

1. Create two recurring monthly prices (Pro, Business) in the Stripe
   dashboard; copy their `price_…` ids into `BILLING_PRO_PRICE_ID` /
   `BILLING_BUSINESS_PRICE_ID`. Set `BILLING_*_AMOUNT` / `BILLING_CURRENCY` to
   the same values for display.
2. Create a **restricted** key with write access to Customers, Checkout
   Sessions, Subscriptions, Billing Portal and read access to Invoices;
   set `BILLING_SECRET_KEY`.
3. Add a webhook endpoint `https://<APP_URL>/api/billing/webhook` with the
   events listed above; set `BILLING_WEBHOOK_SECRET` to its signing secret.
4. Configure the Customer Portal in Stripe (allow plan switching between the
   two prices, cancellation at period end, invoice history).
5. Set `BILLING_PROVIDER=stripe`, deploy, verify `/api/ready` and that
   `GET /api/billing/plans` reports `purchasable: true`.
6. Send a test event from the Stripe dashboard and confirm a `200` with
   `outcome: "ignored"` (unknown customer) — that proves the signature
   configuration.
7. Perform one real checkout with a test card in test mode before switching
   to live keys; confirm the audit trail and `subscription_activated`.

Rotate `BILLING_WEBHOOK_SECRET` by adding the new endpoint first, switching
the variable, then deleting the old endpoint.

## Tax, regional pricing and refunds

- Tax calculation, invoices, VAT/GST ids and receipts are the provider's
  job (enable Stripe Tax and collect tax ids in Checkout/Portal). ExtensionLab
  stores nothing tax-related.
- One currency is configured per deployment (`BILLING_CURRENCY`); regional
  price lists would be additional price ids per plan, which the mapping in
  `config.ts` can be extended to without a schema change.
- Refunds and disputes are issued in the provider dashboard. A refunded
  subscription that the provider cancels produces the normal
  `subscription.deleted` webhook; nothing manual is needed in the app.
- Annual plans are not offered; the model supports them as a second price on
  the same plan id.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Return page stays on "being confirmed" | Webhook not reaching the app, or wrong `BILLING_WEBHOOK_SECRET` | Check provider dashboard delivery log; look for `billing.webhook_rejected`; the confirm path also activates once the provider marks the session complete, so a working `BILLING_SECRET_KEY` usually rescues the user |
| `400 WEBHOOK_SIGNATURE_INVALID` for every event | Secret mismatch or body rewritten by a proxy | Use the endpoint's own signing secret; make sure the proxy passes the raw body untouched |
| `429` on the webhook | Provider replaying a large backlog | Raise `RATE_LIMIT_BILLING_WEBHOOK_PER_MIN` temporarily; the provider retries |
| User paid but is Free | Event applied to an unknown customer (`outcome: ignored`) | Confirm the `billing_customers` row exists for the user; re-send the subscription event from the provider dashboard |
| Dashboard says "Payment issue" | Renewal failed | User updates the card in the portal; recovery arrives as `invoice.paid` |
| `503 BILLING_NOT_CONFIGURED` | `BILLING_PROVIDER=disabled` or missing keys | See configuration above |
| `502 BILLING_PROVIDER_ERROR` on checkout | Provider API down or key revoked | `billing.provider_error` metric/log has the `errorCode`; the user message is generic and includes a reference id |
| Account deletion fails with a billing error | Provider cancel failed | Retry; if the provider is down for long, cancel the subscription manually in the dashboard and retry deletion |
| Duplicate audit rows after a replay | Not expected | The `billing_events` unique index prevents double application; check `billing.webhook_duplicate` and the event id |

## Phase 13: fail-closed entitlements

Entitlement lookups (effective plan, quotas, interactive limits) read the
subscription store directly; there is **no fallback that widens access**. If
the lookup fails (store unreachable), gated actions fail with an error — never
a silent downgrade *or* upgrade. Verified by
`tests/phase13/billing-failclosed.test.ts`. Heavy resource profiles are a plan
entitlement evaluated server-side at container start.


## Phase 14: Razorpay

`BILLING_PROVIDER=razorpay` adds a second real adapter behind the same
provider interface (Stripe untouched). See [RAZORPAY.md](RAZORPAY.md) for the
full operator guide. Key properties:

- **Self-serve**: `/pricing` → Buy Now → Razorpay Standard Checkout →
  server-side verification (relayed checkout signature + provider lookup) →
  webhook confirmation → automatic activation. No manual step.
- **Razorpay subscriptions** (not hand-rolled recurring billing); the local
  DB never assumes success just because checkout opened.
- **Fail-closed configuration**: missing credentials are startup errors in
  every environment; the fake provider is still development/test-only.
- **Price-change protection**: the adapter verifies the Razorpay plan's
  amount/currency against the catalog and rejects mismatches
  (`PAYMENT_MISMATCH`) before creating anything.
- **Payments ledger** (migration 011): normalized, idempotent payment records
  (`billing_payments`) power the dashboard's payment history; no card data
  ever reaches ExtensionLab.
- **Capabilities are honest**: no hosted portal, no reactivate (Razorpay has
  no resume-scheduled-cancel); cancel is at cycle end.

## Phase 15: studio runs bill through the existing pipeline

Saved-test runs (dashboard, suite, matrix or CI) use the same
reserve → queue → run → consume/release transaction as every other test run.
`Idempotency-Key` replays return the original run instead of reserving twice,
so retried CI pipelines are never double-charged. Definitions and version
history are metadata: storing and editing tests never consumes quota.
