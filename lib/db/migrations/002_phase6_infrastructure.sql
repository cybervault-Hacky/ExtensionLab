-- ExtensionLab Phase 6: production infrastructure.
-- Additive only. Existing Phase 5 rows are never modified or deleted.
-- All identifiers are non-guessable TEXT ids supplied by the application.

-- Stored extension packages (immutable ZIP blobs referenced by storage key).
CREATE TABLE IF NOT EXISTS extension_packages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  extension_id TEXT,
  storage_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  version TEXT,
  original_name TEXT,
  status TEXT NOT NULL DEFAULT 'stored',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (extension_id) REFERENCES extensions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_packages_user_sha ON extension_packages(user_id, sha256);
CREATE INDEX IF NOT EXISTS idx_packages_extension_id ON extension_packages(extension_id);
CREATE INDEX IF NOT EXISTS idx_packages_status ON extension_packages(status);

-- Persistent background jobs.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  user_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  idempotency_key TEXT UNIQUE,
  resource_type TEXT,
  resource_id TEXT,
  worker_id TEXT,
  lease_expires_at INTEGER,
  run_after INTEGER NOT NULL,
  cancel_requested_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_run_after ON jobs(status, run_after);
CREATE INDEX IF NOT EXISTS idx_jobs_user_status ON jobs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_resource ON jobs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_jobs_type_status ON jobs(type, status);

-- Ordered progress events per job (stage transitions and live test events).
CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  stage TEXT,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, id);

-- Worker heartbeats (readiness reporting; never exposed to clients).
CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  concurrency INTEGER NOT NULL DEFAULT 1,
  active_jobs INTEGER NOT NULL DEFAULT 0,
  sandbox_available INTEGER,
  sandbox_detail TEXT,
  stopping INTEGER NOT NULL DEFAULT 0
);

-- Atomic quota reservations taken when a job is accepted.
CREATE TABLE IF NOT EXISTS quota_reservations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  resource_id TEXT,
  job_id TEXT,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER,
  released_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reservations_user_kind ON quota_reservations(user_id, kind, consumed_at, released_at);
CREATE INDEX IF NOT EXISTS idx_reservations_resource ON quota_reservations(resource_id);

-- Private evidence artifacts produced by automated test runs.
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  test_run_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (test_run_id) REFERENCES test_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(test_run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_expires ON artifacts(expires_at);

-- Link snapshots and test runs to the exact package that produced them.
ALTER TABLE analysis_snapshots ADD COLUMN package_id TEXT REFERENCES extension_packages(id) ON DELETE SET NULL;
ALTER TABLE test_runs ADD COLUMN package_id TEXT REFERENCES extension_packages(id) ON DELETE SET NULL;
ALTER TABLE test_runs ADD COLUMN job_id TEXT;
ALTER TABLE test_runs ADD COLUMN stage TEXT;
ALTER TABLE test_runs ADD COLUMN outcome TEXT;
ALTER TABLE test_runs ADD COLUMN error_code TEXT;
ALTER TABLE test_runs ADD COLUMN reason TEXT;
ALTER TABLE test_runs ADD COLUMN access_token_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_test_runs_job_id ON test_runs(job_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_package_id ON test_runs(package_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_package_id ON analysis_snapshots(package_id);
