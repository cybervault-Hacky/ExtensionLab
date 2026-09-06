-- ExtensionLab Phase 12: testing workspace extensions.
-- Additive only. Existing rows are never modified or deleted.
-- Identifiers are non-guessable TEXT ids supplied by the application.
-- SQL is kept ANSI/PostgreSQL-portable (no SQLite-only types or pragmas).

-- ---------------------------------------------------------------------------
-- Session evidence
--
-- One row per user-marked piece of evidence from an interactive browser
-- session. Evidence REFERENCES runtime records (ring entry ids, durable event
-- seqs, artifact ids) and stores only a bounded summary — large payloads
-- (screenshots, full rings) are never duplicated here. Screenshots keep
-- pointing at the existing artifact system, which owns retention.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS session_evidence (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  organization_id TEXT,                        -- owning organization when applicable
  kind TEXT NOT NULL CHECK (kind IN ('console','network','event','screenshot','test_recipe')),
  ref_id TEXT,                                 -- referenced runtime record id / seq / artifact id
  label TEXT,                                  -- optional user label (bounded)
  summary TEXT NOT NULL,                       -- bounded human-readable summary (never a payload copy)
  metadata_json TEXT NOT NULL DEFAULT '{}',    -- bounded, redacted metadata
  package_id TEXT,
  package_version TEXT,
  package_sha256 TEXT NOT NULL,
  browser TEXT NOT NULL,
  browser_version TEXT,
  report_id TEXT,                              -- attached report when saved to one
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES interactive_browser_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_session_evidence_session ON session_evidence(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_evidence_user ON session_evidence(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_evidence_report ON session_evidence(report_id) WHERE report_id IS NOT NULL;
