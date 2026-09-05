-- Phase 8: AI assistance layer.
-- Additive only: Phase 1–7 tables and rows are left untouched.

-- Validated AI results linked to the resource they explain. Only the
-- schema-validated, safe response is stored (never prompts, never raw
-- provider payloads, never the sanitized context). Rows cascade with the
-- owning user and are pruned by the cleanup job after AI_RESULT_RETENTION_DAYS.
CREATE TABLE IF NOT EXISTS ai_results (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  /* Kind + id of the ExtensionLab resource the result is about (report/run/snapshot). */
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  /* Sub-target inside the resource (finding id, test id, question hash); nullable. */
  target_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  /* Fingerprint of the sanitized context; lets the service reuse a result for identical evidence. */
  context_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ai_results_lookup
  ON ai_results(user_id, feature, resource_kind, resource_id, target_id, context_hash);
CREATE INDEX IF NOT EXISTS idx_ai_results_expires ON ai_results(expires_at);
