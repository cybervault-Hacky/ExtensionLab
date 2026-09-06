# Razorpay Billing (Phase 14)

Self-serve checkout: a user picks a plan on `/pricing`, clicks **Buy Now**,
pays in Razorpay Standard Checkout, and the plan activates automatically —
no manual approval, no "Contact Us". This document is the operator guide; the
architecture lives in [BILLING.md](BILLING.md) and
[ARCHITECTURE.md](ARCHITECTURE.md).

Never put real credentials in this file, the repository, or any commit.

## How the flow works

```
/pricing → Buy Now
   → POST /api/billing/checkout      (session-authenticated; server picks the price)
   → Razorpay subscription created   (server-side, on the mapped Razorpay plan)
   → browser opens Razorpay Checkout (public key id + subscription reference only)
   → payment / mandate
   → POST /api/billing/confirm       (relayed signature verified server-side, then
                                      the provider is asked for the truth)
   → Razorpay webhook                (x-razorpay-signature, HMAC-SHA256 over the raw body)
   → event ledger (idempotent) → subscription sync → entitlement activation
   → dashboard reflects the new plan; quotas apply immediately
```

The browser confirms nothing: a `payment_success` claim from the client is
never trusted; entitlement changes come only from verified provider state.

## Account setup (test mode first)

1. Create a Razorpay account and switch to **Test Mode**.
2. Dashboard → Settings → API Keys → **Generate Test Key**. You get
   `Key Id` (`rzp_test_…`) and `Key Secret`.
3. Dashboard → Subscriptions → **Plans**: create a monthly plan per paid
   ExtensionLab plan. The plan's amount must equal the catalog price:
     - Pro: ₹799.00 → `79900` paise
     - Business: ₹2499.00 → `249900` paise
   Amounts are integer smallest-unit (paise). Floating point is never used.
4. Settings → Webhooks → **Add New Webhook**:
     - URL: `https://<your-domain>/api/billing/webhook` (HTTPS only in production)
     - Secret: a strong random value → `RAZORPAY_WEBHOOK_SECRET`
     - Active events: `payment.captured`, `payment.failed`,
       `subscription.authenticated`, `subscription.activated`,
       `subscription.charged`, `subscription.pending`, `subscription.halted`,
       `subscription.cancelled`, `subscription.completed`

## Environment variables

```bash
BILLING_PROVIDER=razorpay
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx     # public; the only client-visible value
RAZORPAY_KEY_SECRET=                      # server-only
RAZORPAY_WEBHOOK_SECRET=                  # server-only
RAZORPAY_PLAN_ID_PRO=plan_xxxxxxxxxxxx    # ExtensionLab pro → Razorpay plan
RAZORPAY_PLAN_ID_BUSINESS=plan_xxxxxxxxxxxx
BILLING_CURRENCY=inr
BILLING_PRO_AMOUNT=79900                  # catalog amounts in paise
BILLING_BUSINESS_AMOUNT=249900
```

Validation fails closed in every environment: selecting `razorpay` without
the full credential set (or without at least one plan mapping) is a startup
configuration error — there is **no silent fallback to fake billing**. The
`fake` provider remains available for development/tests only and is rejected
in production.

Secrets are server-only: never in client bundles, API responses, logs, error
messages, `describeConfig()`, docs or Git. Only `RAZORPAY_KEY_ID` reaches the
browser, and only because Razorpay Checkout requires it.

## Plan mapping and price verification

- One source of truth: the Phase 7 plan catalog (`lib/billing/plans.ts` +
  `BILLING_*` env). Prices shown on `/pricing`, charged by Razorpay and
  verified server-side all come from it. The UI and the client never set a
  price.
- The adapter maps ExtensionLab plan ids → Razorpay plan ids
  (`RAZORPAY_PLAN_ID_*`).
- **Price-change protection**: at checkout creation the adapter reads the
  Razorpay plan and compares amount + currency with the catalog. A mismatch
  fails closed with `PAYMENT_MISMATCH` (nothing created, nothing charged).

## Webhook configuration

- URL: `POST /api/billing/webhook` (shared endpoint; the Razorpay adapter
  verifies `x-razorpay-signature` = HMAC-SHA256 of the exact raw body with
  `RAZORPAY_WEBHOOK_SECRET`).
- The raw body is verified byte-for-byte before JSON parsing; a
  re-serialized body fails verification.
- Idempotency: every event id is claimed in the `billing_events` ledger
  before processing; duplicates return 200 without re-applying state.
- Out-of-order delivery is safe: a snapshot older than the last applied one
  is ignored (event-timestamp guard in `upsertSubscription`).
- Production webhooks must arrive over HTTPS. For local development, use
  your own tunnel or test the signature path with the deterministic suite;
  no third-party tunnel is hardcoded.

## Subscription lifecycle mapping

| Razorpay | ExtensionLab | User-visible effect |
| --- | --- | --- |
| `created` | `incomplete` (checkout open) | return page shows "confirming" |
| `authenticated` / `active` | `active` | plan active, quotas updated |
| `pending` (retrying charge) | `past_due` | paid features kept during the configured grace window (`BILLING_PAST_DUE_GRACE_DAYS`, default 7), then Free |
| `halted` (retries exhausted) | `unpaid` | grace policy applies, then Free |
| `cancelled` | `canceled` | ends at period end when cancelled via the dashboard; historical data is never deleted |
| `completed` (all cycles done) | `active` until cycle end, then `canceled` | keeps what was paid for, then Free |

Renewals (`subscription.charged`) advance the billing period and quota
window without creating duplicate subscriptions. Payments are recorded once
per provider payment id in the `billing_payments` ledger (migration 011).

## Cancellation, reactivation, portal

- Cancel (`/dashboard/billing` or `POST /api/billing/cancel`) cancels **at
  cycle end**; paid access remains until the period ends.
- Reactivation of a scheduled cancel is **not supported by Razorpay** — the
  capability is reported as false and the UI does not offer it.
- Razorpay has no Stripe-style hosted portal; plan management (status,
  renewal date, usage, payment history, cancel) happens on the ExtensionLab
  billing page, and invoices are linked from Razorpay when available.

## Local development / test mode

- Without Razorpay credentials, run `BILLING_PROVIDER=fake` (never in
  production) — the fake provider powers the whole UI flow deterministically.
- The deterministic Phase 14 suite (`tests/phase14/`) runs the REAL adapter
  against an in-memory Razorpay API double: signature verification, webhook
  idempotency, lifecycle mapping, races, price-change protection.
- Real test-mode checks: `EXTENSIONLAB_E2E_RAZORPAY=1` with test credentials
  runs `tests/e2e/phase14-razorpay.e2e.test.ts` (never live keys; refuses
  `rzp_live_`). Without the flag it skips with an explicit reason.

## Content-Security-Policy

Razorpay Standard Checkout needs script/frame/connect allowances. The Edge
middleware evaluates this at **build time**: set `BILLING_PROVIDER=razorpay`
(or `CSP_RAZORPAY=1`) in the *build* environment so
`lib/security/csp.ts` adds exactly:

- `script-src https://checkout.razorpay.com`
- `frame-src https://api.razorpay.com https://checkout.razorpay.com https://www.razorpay.com`
- `connect-src https://api.razorpay.com https://checkout.razorpay.com`
- `img-src https://*.razorpay.com` (checkout modal assets)

No secrets are involved in this decision.

## Monitoring & alerting (documented, not pre-configured)

Metrics emitted (no payment data in labels): `billing.checkout_attempt`,
`billing.checkout_failed`, `billing.webhook_received/rejected/duplicate`,
`billing.payment_verification_failed`, `billing.payment_recorded`,
`billing.payment_failed`, `billing.subscription_changed`,
`billing.provider_error`. Suggested alerts — configure them in your own
monitoring stack: webhook failure spike, payment verification failure spike,
provider unavailable, `billing_events` stuck in `processing` (sync backlog),
and any `BILLING_CONFIGURATION_ERROR`.

## Failure behavior

- Razorpay API down → checkout/cancel answer `BILLING_PROVIDER_UNAVAILABLE`
  (503); nothing is activated, marked paid or recorded.
- Ambiguous state → fail closed: no paid entitlement is granted, and an
  unrelated valid subscription is never revoked because of an outage.
- Webhook processing failure → 500 so Razorpay retries; the event ledger
  guarantees at-most-once application.
- Payment failure → the user's current plan is unchanged; the failure is
  recorded (audit + payments ledger) with amount/currency only.

## Troubleshooting

| Symptom | Likely cause | Check |
| --- | --- | --- |
| Startup error listing `RAZORPAY_*` | missing credentials / plan mapping | `.env` values, `npm run db:migrate` unaffected |
| `/pricing` shows "Not yet available" | billing disabled or plan ids unconfigured | `BILLING_PROVIDER`, `RAZORPAY_PLAN_ID_*` |
| Checkout modal does not open | CSP missing checkout origins | build env had `BILLING_PROVIDER=razorpay`? |
| Payment stuck "confirming" | webhook not delivered | Razorpay webhook URL/secret, `billing_events` table |
| `PAYMENT_MISMATCH` at checkout | Razorpay plan price ≠ catalog | plan amount in the Razorpay dashboard |
| Webhook 400 `WEBHOOK_SIGNATURE_INVALID` | wrong secret or body re-encoding | `RAZORPAY_WEBHOOK_SECRET` matches the dashboard; proxy must not rewrite bodies |
