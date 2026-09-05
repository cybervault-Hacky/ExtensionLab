-- ExtensionLab Phase 9: cross-browser testing.
-- Additive only. Existing rows are never modified or deleted.
-- All identifiers are non-guessable TEXT ids supplied by the application.

-- Browser matrix runs: one parent row per cross-browser test request.
CREATE TABLE IF NOT EXISTS browser_matrix_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  extension_id TEXT,
  package_id TEXT NOT NULL,
  test_suite_id TEXT NOT NULL,
  test_suite_name TEXT,
  browsers_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  compatibility_score INTEGER,
  coverage REAL,
  comparison_json TEXT,
  report_id TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (extension_id) REFERENCES extensions(id) ON DELETE SET NULL,
  FOREIGN KEY (package_id) REFERENCES extension_packages(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_matrix_runs_user_status ON browser_matrix_runs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_matrix_runs_extension ON browser_matrix_runs(extension_id);
CREATE INDEX IF NOT EXISTS idx_matrix_runs_package ON browser_matrix_runs(package_id);
CREATE INDEX IF NOT EXISTS idx_matrix_runs_created ON browser_matrix_runs(created_at);

-- One child execution per (matrix run, browser). Each execution owns exactly
-- one test_runs row and one job row.
CREATE TABLE IF NOT EXISTS browser_matrix_executions (
  id TEXT PRIMARY KEY,
  matrix_run_id TEXT NOT NULL,
  browser_id TEXT NOT NULL,
  browser_version TEXT,
  engine TEXT,
  test_run_id TEXT NOT NULL,
  job_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  outcome TEXT,
  error_code TEXT,
  reason TEXT,
  score INTEGER,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  UNIQUE (matrix_run_id, browser_id),
  FOREIGN KEY (matrix_run_id) REFERENCES browser_matrix_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (test_run_id) REFERENCES test_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_matrix_exec_run ON browser_matrix_executions(matrix_run_id);
CREATE INDEX IF NOT EXISTS idx_matrix_exec_browser ON browser_matrix_executions(browser_id, status);

-- Designated baselines reference exact versions — never an ambiguous "latest".
CREATE TABLE IF NOT EXISTS test_baselines (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  extension_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  snapshot_id TEXT,
  test_suite_id TEXT NOT NULL,
  browsers_json TEXT NOT NULL,
  matrix_run_id TEXT,
  run_id TEXT,
  score INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, extension_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (extension_id) REFERENCES extensions(id) ON DELETE CASCADE,
  FOREIGN KEY (package_id) REFERENCES extension_packages(id) ON DELETE CASCADE,
  FOREIGN KEY (matrix_run_id) REFERENCES browser_matrix_runs(id) ON DELETE SET NULL,
  FOREIGN KEY (run_id) REFERENCES test_runs(id) ON DELETE SET NULL
);

-- Stored regression comparisons (previous vs current package version).
CREATE TABLE IF NOT EXISTS regression_comparisons (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  extension_id TEXT,
  package_version_id_prev TEXT,
  package_version_id_current TEXT,
  test_suite_id TEXT,
  browsers_json TEXT NOT NULL,
  previous_matrix_run_id TEXT,
  current_matrix_run_id TEXT,
  previous_run_id TEXT,
  current_run_id TEXT,
  result_json TEXT NOT NULL,
  regression_count INTEGER NOT NULL DEFAULT 0,
  improvement_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (previous_matrix_run_id) REFERENCES browser_matrix_runs(id) ON DELETE SET NULL,
  FOREIGN KEY (current_matrix_run_id) REFERENCES browser_matrix_runs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_regressions_user ON regression_comparisons(user_id, created_at);

-- Browser metadata on single runs (null = pre-Phase-9 Chromium-only rows).
ALTER TABLE test_runs ADD COLUMN browser_id TEXT;
ALTER TABLE test_runs ADD COLUMN browser_version TEXT;
ALTER TABLE test_runs ADD COLUMN engine TEXT;
ALTER TABLE test_runs ADD COLUMN matrix_run_id TEXT REFERENCES browser_matrix_runs(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_test_runs_browser ON test_runs(browser_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_matrix ON test_runs(matrix_run_id);
