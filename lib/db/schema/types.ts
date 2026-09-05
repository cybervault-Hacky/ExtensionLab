export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  avatar_url: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
  last_active_at: number;
  user_agent: string | null;
  ip_address: string | null;
}

export interface PasswordResetRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

export interface ExtensionRow {
  id: string;
  user_id: string;
  name: string;
  version: string | null;
  manifest_version: string | null;
  source_name: string | null;
  health_score: number;
  status: string;
  last_analyzed_at: number | null;
  last_tested_at: number | null;
  last_test_status: string | null;
  created_at: number;
  updated_at: number;
}

export interface AnalysisSnapshotRow {
  id: string;
  extension_id: string;
  health_score: number;
  manifest_version: string | null;
  analysis_json: string;
  created_at: number;
}

export interface TestRunRow {
  id: string;
  user_id: string;
  extension_id: string | null;
  status: string;
  score: number;
  total: number;
  passed: number;
  failed: number;
  warnings: number;
  skipped: number;
  timeout: number;
  error_count: number;
  started_at: number | null;
  completed_at: number | null;
  result_json: string | null;
  diagnostics_json: string | null;
  events_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface ReportRow {
  id: string;
  user_id: string;
  extension_id: string | null;
  analysis_snapshot_id: string | null;
  test_run_id: string | null;
  title: string;
  summary: string | null;
  health_score: number | null;
  runtime_score: number | null;
  overall_score: number | null;
  report_json: string;
  created_at: number;
  updated_at: number;
}

export interface ShareRow {
  id: string;
  report_id: string;
  token: string;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

export interface AuditEventRow {
  id: string;
  user_id: string | null;
  type: string;
  detail: string | null;
  created_at: number;
}

export interface UsageEventRow {
  id: string;
  user_id: string;
  kind: string;
  created_at: number;
}
