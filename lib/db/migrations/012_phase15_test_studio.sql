-- Phase 15: Test Automation Studio persistence.
--
-- Saved tests, their immutable version history, and user-defined suites.
-- Definitions are validated JSON (schemaVersion 1) built ONLY from the
-- Phase 4 allowlisted actions/assertions; the engine re-validates at
-- execution time. Runs record the exact saved test + version they executed
-- (test_runs.saved_test_id / saved_test_version) so historical runs stay
-- reproducible and immutable when the definition is edited later.
--
-- No secrets are stored: the schema intentionally has no encrypted or
-- plaintext secret-variable columns (Phase 15 §14 — secrets are not
-- implemented because the current architecture has no per-tenant key
-- management; user-facing variables are typed inputs only).

CREATE TABLE IF NOT EXISTS saved_tests (
  id TEXT PRIMARY KEY,
  organization_id TEXT,
  user_id TEXT NOT NULL,
  extension_id TEXT,
  package_id TEXT NOT NULL,
  package_sha256 TEXT NOT NULL,
  package_version TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED')),
  current_version INTEGER NOT NULL DEFAULT 1,
  tags_json TEXT NOT NULL DEFAULT '[]',
  browser_targets_json TEXT NOT NULL DEFAULT '["chromium"]',
  definition_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_saved_tests_org_status ON saved_tests(organization_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_tests_user ON saved_tests(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_tests_package ON saved_tests(package_id);

CREATE TABLE IF NOT EXISTS saved_test_versions (
  id TEXT PRIMARY KEY,
  test_id TEXT NOT NULL REFERENCES saved_tests(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (test_id, version)
);

CREATE TABLE IF NOT EXISTS saved_test_suites (
  id TEXT PRIMARY KEY,
  organization_id TEXT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  failure_policy TEXT NOT NULL DEFAULT 'stop' CHECK (failure_policy IN ('stop','continue')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_saved_test_suites_org ON saved_test_suites(organization_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS saved_test_suite_items (
  id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL REFERENCES saved_test_suites(id) ON DELETE CASCADE,
  test_id TEXT NOT NULL REFERENCES saved_tests(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  /** Explicit dependencies on earlier members (saved test ids, JSON array). */
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (suite_id, test_id)
);

CREATE INDEX IF NOT EXISTS idx_suite_items_suite ON saved_test_suite_items(suite_id, position);

-- Bind executed runs to the exact saved test + version they ran (§16/§17).
ALTER TABLE test_runs ADD COLUMN saved_test_id TEXT;
ALTER TABLE test_runs ADD COLUMN saved_test_version INTEGER;

CREATE INDEX IF NOT EXISTS idx_test_runs_saved_test ON test_runs(saved_test_id, created_at DESC);

-- Phase 15 saved-test baselines ("Save Run as Baseline"). Reuses the Phase 9
-- baseline *concept* scoped to saved tests; the comparison itself is the
-- deterministic classifier in lib/testing/studio-baseline.ts. One baseline
-- per (user, saved test); replacing it never rewrites history (runs persist).
CREATE TABLE IF NOT EXISTS saved_test_baselines (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  saved_test_id TEXT NOT NULL REFERENCES saved_tests(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  test_version INTEGER NOT NULL,
  package_sha256 TEXT NOT NULL,
  browser_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  duration_ms INTEGER,
  summary_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, saved_test_id)
);
