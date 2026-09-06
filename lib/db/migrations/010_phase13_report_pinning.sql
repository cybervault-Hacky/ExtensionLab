-- Phase 13: report pinning.
--
-- A pinned report protects its linked artifacts from retention deletion for
-- as long as the pin holds (§ artifact retention respects report pinning).
-- Pinning is per-report, ownership-checked, and reversible.

ALTER TABLE reports ADD COLUMN pinned_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_reports_pinned ON reports(pinned_at) WHERE pinned_at IS NOT NULL;
