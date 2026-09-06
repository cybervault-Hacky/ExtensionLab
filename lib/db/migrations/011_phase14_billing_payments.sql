-- Phase 14: local payments ledger.
--
-- Normalized payment records written ONLY from verified provider events
-- (webhook) or provider-confirmed checkouts. The unique index on
-- (provider, provider_payment_id) makes recording idempotent: a duplicate
-- webhook delivery can never double-count a payment (§17/§30).
--
-- No payment-instrument data is ever stored: Razorpay owns cards; this table
-- holds provider ids, the plan, integer minor-unit amount, currency, status.

CREATE TABLE IF NOT EXISTS billing_payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_payment_id TEXT NOT NULL,
  provider_invoice_id TEXT,
  provider_subscription_id TEXT,
  plan_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (provider, provider_payment_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_payments_user ON billing_payments(user_id, created_at DESC);
