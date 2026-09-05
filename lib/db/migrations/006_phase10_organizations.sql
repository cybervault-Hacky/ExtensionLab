-- ExtensionLab Phase 10: organizations, public API, webhooks, audit.
-- Additive only. Existing rows are never modified or deleted.
-- Identifiers are non-guessable TEXT ids supplied by the application.
-- SQL is kept ANSI/PostgreSQL-portable (no SQLite-only types or pragmas).

-- ---------------------------------------------------------------------------
-- Organizations and membership
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL DEFAULT 'free',
  plan_status TEXT NOT NULL DEFAULT 'none',        -- none | active | canceled
  provider TEXT,                                    -- billing provider for the org subscription
  provider_subscription_id TEXT,
  seats INTEGER NOT NULL DEFAULT 1,                 -- billed seats (server-authoritative)
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_organizations_owner ON organizations(owner_user_id);

CREATE TABLE IF NOT EXISTS organization_members (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','developer','viewer')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);

-- Invitation tokens are random and stored only as SHA-256 hashes.
CREATE TABLE IF NOT EXISTS organization_invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','developer','viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_by TEXT,
  revoked_at INTEGER,
  resend_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_org_invitations_org ON organization_invitations(organization_id, created_at);

-- Verified organization domains (DNS TXT verification; token is public-by-design).
CREATE TABLE IF NOT EXISTS organization_domains (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  domain TEXT NOT NULL UNIQUE,
  verification_token TEXT NOT NULL,
  verified_at INTEGER,
  verified_by TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_org_domains_org ON organization_domains(organization_id);

-- SSO configuration per organization. Secrets (OIDC client secret) live in
-- config_json server-side only and are never projected to clients.
CREATE TABLE IF NOT EXISTS organization_sso_configs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL UNIQUE,
  protocol TEXT NOT NULL CHECK (protocol IN ('oidc','saml')),
  status TEXT NOT NULL DEFAULT 'configured' CHECK (status IN ('configured','enforced')),
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Customer API keys (never payment-provider keys). Only hashes are stored.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organization_api_keys (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  last_used_at INTEGER,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_org_api_keys_org ON organization_api_keys(organization_id, created_at);

-- ---------------------------------------------------------------------------
-- Customer webhooks and delivery history
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organization_webhooks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,                 -- per-webhook signing secret (needed to sign)
  events_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_org_webhooks_org ON organization_webhooks(organization_id);

CREATE TABLE IF NOT EXISTS organization_webhook_deliveries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_status_code INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (webhook_id) REFERENCES organization_webhooks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_org_webhook_deliveries_org ON organization_webhook_deliveries(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_org_webhook_deliveries_state ON organization_webhook_deliveries(status, next_attempt_at);

-- ---------------------------------------------------------------------------
-- Immutable organization audit events (metadata is redacted before storage)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organization_audit_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  actor_user_id TEXT,
  actor_api_key_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  request_id TEXT,
  ip TEXT,
  success INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_org_audit_org_time ON organization_audit_events(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_org_audit_action ON organization_audit_events(organization_id, action);

-- ---------------------------------------------------------------------------
-- Idempotency records for expensive public API operations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS api_idempotency_records (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('user','organization')),
  owner_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_flight' CHECK (status IN ('in_flight','completed')),
  response_status INTEGER,
  response_json TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  expires_at INTEGER NOT NULL,
  UNIQUE (owner_type, owner_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON api_idempotency_records(expires_at);

-- ---------------------------------------------------------------------------
-- CI/quality-gate policies (one active policy per organization)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organization_policies (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT 'Default quality gates',
  rules_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Asynchronous organization data exports
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organization_exports (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','expired')),
  storage_key TEXT,
  size INTEGER,
  sha256 TEXT,
  expires_at INTEGER NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_org_exports_org ON organization_exports(organization_id, created_at);

-- ---------------------------------------------------------------------------
-- Public report publications (opt-in, sanitized projection only)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS report_publications (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  summary TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_report_publications_org ON report_publications(organization_id);

-- ---------------------------------------------------------------------------
-- Existing tables gain an optional organization ownership column.
-- Application-level scoping keeps existing personal-workspace rows untouched.
-- ---------------------------------------------------------------------------

ALTER TABLE extensions ADD COLUMN organization_id TEXT;
ALTER TABLE extension_packages ADD COLUMN organization_id TEXT;
ALTER TABLE test_runs ADD COLUMN organization_id TEXT;
ALTER TABLE reports ADD COLUMN organization_id TEXT;
ALTER TABLE browser_matrix_runs ADD COLUMN organization_id TEXT;
ALTER TABLE jobs ADD COLUMN organization_id TEXT;
ALTER TABLE checkout_sessions ADD COLUMN organization_id TEXT;

CREATE INDEX IF NOT EXISTS idx_extensions_org ON extensions(organization_id);
CREATE INDEX IF NOT EXISTS idx_packages_org ON extension_packages(organization_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_org ON test_runs(organization_id);
CREATE INDEX IF NOT EXISTS idx_reports_org ON reports(organization_id);
CREATE INDEX IF NOT EXISTS idx_matrix_runs_org ON browser_matrix_runs(organization_id);
CREATE INDEX IF NOT EXISTS idx_jobs_org_state ON jobs(organization_id, status);
