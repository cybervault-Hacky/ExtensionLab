-- ExtensionLab Phase 13: production worker registry and scaling support.
-- Additive only. Existing rows are never modified or deleted (new columns are
-- nullable / defaulted). SQL stays ANSI/PostgreSQL-portable.

-- ---------------------------------------------------------------------------
-- Worker lifecycle registry.
--
-- The Phase 6 `workers` table already stores heartbeats. Phase 13 adds:
--  - version/capabilities reported at registration (§5)
--  - ready_at: first successful heartbeat + sandbox probe (STARTING → READY)
--  - desired_state: operator-controlled scheduling intent
--    ('running' | 'draining' | 'disabled'); the observed state is DERIVED from
--    last_seen_at + stopping + desired_state + ready_at (never stored), so a
--    crashed worker can never appear healthy.
-- ---------------------------------------------------------------------------

ALTER TABLE workers ADD COLUMN version TEXT;
ALTER TABLE workers ADD COLUMN capabilities_json TEXT;
ALTER TABLE workers ADD COLUMN ready_at INTEGER;
ALTER TABLE workers ADD COLUMN desired_state TEXT NOT NULL DEFAULT 'running';

-- ---------------------------------------------------------------------------
-- Queue observability: bounded "oldest queued job age" and admin queue views
-- need a covering index on (status, created_at). Reconciliation queries that
-- look up running jobs by worker also benefit from a worker index.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_worker_status ON jobs(worker_id, status);

-- Interactive session capacity accounting (§11): the runtime-slot count is a
-- hot path in claimStartSlot; this index keeps it cheap at any fleet size.
CREATE INDEX IF NOT EXISTS idx_ibrowser_sessions_status
  ON interactive_browser_sessions(status);
