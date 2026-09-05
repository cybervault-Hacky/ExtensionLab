-- Phase 7: monetization, plans and subscription billing.
-- Additive only: Phase 1–6 tables and rows are left untouched.

-- One provider customer per user per provider. Only the provider identifier
-- is stored; payment instruments never leave the provider.
CREATE TABLE IF NOT EXISTS billing_customers (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_customer_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_customers_provider_customer
  ON billing_customers(provider, provider_customer_id);

-- Synchronized copy of the provider's subscription state. The provider (via
-- verified webhooks) is authoritative; users never write this table directly.
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_customer_id TEXT NOT NULL,
  provider_subscription_id TEXT NOT NULL,
  provider_price_id TEXT,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_period_start INTEGER,
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  cancel_at INTEGER,
  canceled_at INTEGER,
  trial_end INTEGER,
  ended_at INTEGER,
  /* Provider event timestamp of the last applied update; older events are ignored. */
  last_event_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_provider_subscription
  ON subscriptions(provider, provider_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(provider, provider_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_period_end ON subscriptions(current_period_end);

-- Idempotency ledger for webhook deliveries. A row is inserted before
-- processing inside the same transaction that applies the state change, so a
-- failed delivery is retried by the provider and a duplicate is a no-op.
CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  provider_event_type TEXT NOT NULL,
  user_id TEXT,
  subscription_id TEXT,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  processed_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_events_provider_event
  ON billing_events(provider, provider_event_id);
CREATE INDEX IF NOT EXISTS idx_billing_events_user ON billing_events(user_id, created_at);

-- Checkout sessions we created, so the return page can show an honest
-- "being confirmed" state and so a session can only be claimed by its owner.
CREATE TABLE IF NOT EXISTS checkout_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_sessions_provider_session
  ON checkout_sessions(provider, provider_session_id);
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_user ON checkout_sessions(user_id, created_at);

-- Quota lookups now scan a billing period rather than a calendar month.
CREATE INDEX IF NOT EXISTS idx_usage_user_kind_created ON usage_events(user_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_quota_reservations_user_kind_created
  ON quota_reservations(user_id, kind, created_at);
