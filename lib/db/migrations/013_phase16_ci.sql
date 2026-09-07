-- Phase 16: GitHub-native CI/CD integration metadata.
-- Adds bounded CI metadata to test_runs (existing authority) and a
-- dedicated ci_executions record for CI-specific orchestration.
-- All new fields are nullable and backward-safe.

ALTER TABLE test_runs ADD COLUMN provider TEXT;
ALTER TABLE test_runs ADD COLUMN repository TEXT;
ALTER TABLE test_runs ADD COLUMN commit_sha TEXT;
ALTER TABLE test_runs ADD COLUMN branch TEXT;
ALTER TABLE test_runs ADD COLUMN tag TEXT;
ALTER TABLE test_runs ADD COLUMN workflow TEXT;
ALTER TABLE test_runs ADD COLUMN workflow_run_id TEXT;
ALTER TABLE test_runs ADD COLUMN pull_request_number INTEGER;
ALTER TABLE test_runs ADD COLUMN ci_status TEXT CHECK (ci_status IN ('QUEUED','STARTING','RUNNING','COMPLETED','FAILED','TIMEOUT','CANCELLED','INFRASTRUCTURE_ERROR','AUTHENTICATION_ERROR','QUOTA_EXCEEDED'));

CREATE INDEX IF NOT EXISTS idx_test_runs_ci_provider_repo ON test_runs(provider, repository, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_runs_ci_branch ON test_runs(branch, created_at DESC);

-- Dedicated CI execution record (optional; reused when needed).
CREATE TABLE IF NOT EXISTS ci_executions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT,
  test_run_id TEXT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'github',
  repository TEXT,
  commit_sha TEXT,
  branch TEXT,
  tag TEXT,
  workflow TEXT,
  workflow_run_id TEXT,
  pull_request_number INTEGER,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','STARTING','RUNNING','COMPLETED','FAILED','TIMEOUT','CANCELLED','INFRASTRUCTURE_ERROR','AUTHENTICATION_ERROR','QUOTA_EXCEEDED')),
  result_json TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ci_executions_org ON ci_executions(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ci_executions_run ON ci_executions(test_run_id);
CREATE INDEX IF NOT EXISTS idx_ci_executions_repo ON ci_executions(repository, branch, created_at DESC);
