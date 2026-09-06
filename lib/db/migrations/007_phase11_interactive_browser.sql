-- ExtensionLab Phase 11: interactive browser sessions.
-- Additive only. Existing rows are never modified or deleted.
-- Identifiers are non-guessable TEXT ids supplied by the application.
-- SQL is kept ANSI/PostgreSQL-portable (no SQLite-only types or pragmas).

-- ---------------------------------------------------------------------------
-- Interactive browser sessions
--
-- One row per user-launched disposable interactive browser session. The row is
-- the durable source of truth for session state so that any web replica, the
-- worker and the cleanup sweeps agree. `runtime_json` holds host-internal
-- runtime coordinates (control port, runner token, container name, temp dir)
-- and is NEVER returned by any API projection.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS interactive_browser_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  organization_id TEXT,                              -- owning organization when applicable
  extension_id TEXT,                                 -- project reference (nullable)
  package_id TEXT,                                   -- exact immutable package binding
  package_version TEXT,
  package_sha256 TEXT NOT NULL,                      -- binding survives package deletion
  browser TEXT NOT NULL DEFAULT 'chromium',
  browser_version TEXT,
  status TEXT NOT NULL CHECK (status IN
    ('CREATED','QUEUED','STARTING','READY','ACTIVE','IDLE','STOPPING','STOPPED','EXPIRED','FAILED')),
  state_reason TEXT,                                 -- user-safe reason for the current state
  stop_reason TEXT,                                  -- why a terminal state was reached
  initial_url TEXT,
  current_url TEXT,
  viewport_width INTEGER NOT NULL,
  viewport_height INTEGER NOT NULL,
  popup_open INTEGER NOT NULL DEFAULT 0,
  popup_width INTEGER,
  popup_height INTEGER,
  artifact_count INTEGER NOT NULL DEFAULT 0,
  extension_info_json TEXT NOT NULL DEFAULT '{}',    -- safe metadata for the details panel
  runtime_json TEXT NOT NULL DEFAULT '{}',           -- internal; never exposed
  quota_reservation_id TEXT,
  job_id TEXT,
  request_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  ready_at INTEGER,
  last_activity_at INTEGER,
  expires_at INTEGER NOT NULL,                       -- hard maximum-lifetime deadline
  stopped_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
  FOREIGN KEY (extension_id) REFERENCES extensions(id) ON DELETE SET NULL,
  FOREIGN KEY (package_id) REFERENCES extension_packages(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_ibrowser_user_created ON interactive_browser_sessions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ibrowser_org ON interactive_browser_sessions(organization_id);
CREATE INDEX IF NOT EXISTS idx_ibrowser_status ON interactive_browser_sessions(status);
CREATE INDEX IF NOT EXISTS idx_ibrowser_package ON interactive_browser_sessions(package_id);

-- ---------------------------------------------------------------------------
-- Bounded structured session events (lifecycle + observed runtime evidence).
-- Pruned to a per-session window by the repository; never a bulk event dump.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS interactive_session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES interactive_browser_sessions(id) ON DELETE CASCADE,
  UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_ibrowser_events_session ON interactive_session_events(session_id, seq);

-- ---------------------------------------------------------------------------
-- Screenshot artifacts captured from interactive sessions. Mirrors the Phase 6
-- artifacts table shape but is linked to a browser session instead of a test
-- run, so the existing test-run artifact surface stays untouched. Retention
-- and expiry reuse the Phase 6 policies.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS browser_session_artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'screenshot',
  storage_key TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'image/png',
  label TEXT,
  package_version TEXT,
  package_sha256 TEXT,
  browser TEXT,
  browser_version TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES interactive_browser_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ibrowser_artifacts_session ON browser_session_artifacts(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ibrowser_artifacts_expires ON browser_session_artifacts(expires_at);
