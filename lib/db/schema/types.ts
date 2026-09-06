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
  organization_id?: string | null;
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
  package_id?: string | null;
}

export interface TestRunRow {
  id: string;
  organization_id?: string | null;
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
  /** Phase 6 additions (nullable for rows created before migration 002). */
  package_id?: string | null;
  job_id?: string | null;
  stage?: string | null;
  outcome?: string | null;
  error_code?: string | null;
  reason?: string | null;
  access_token_hash?: string | null;
  /** Phase 9 additions (null on pre-Phase-9 rows, which were Chromium-only). */
  browser_id?: string | null;
  browser_version?: string | null;
  engine?: string | null;
  matrix_run_id?: string | null;
}

/** Phase 9: browser matrix run (parent of per-browser child executions). */
export interface BrowserMatrixRunRow {
  id: string;
  user_id: string;
  organization_id?: string | null;
  extension_id: string | null;
  package_id: string;
  test_suite_id: string;
  test_suite_name: string | null;
  browsers_json: string;
  status: string;
  compatibility_score: number | null;
  coverage: number | null;
  comparison_json: string | null;
  report_id: string | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

/** Phase 9: one child execution of a matrix run in a single browser. */
export interface BrowserMatrixExecutionRow {
  id: string;
  matrix_run_id: string;
  browser_id: string;
  browser_version: string | null;
  engine: string | null;
  test_run_id: string;
  job_id: string | null;
  status: string;
  outcome: string | null;
  error_code: string | null;
  reason: string | null;
  score: number | null;
  passed: number;
  failed: number;
  skipped: number;
  evidence_json: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

/** Phase 9: designated baseline (exact versions, never "latest"). */
export interface TestBaselineRow {
  id: string;
  user_id: string;
  extension_id: string;
  package_id: string;
  snapshot_id: string | null;
  test_suite_id: string;
  browsers_json: string;
  matrix_run_id: string | null;
  run_id: string | null;
  score: number | null;
  created_at: number;
  updated_at: number;
}

/** Phase 9: stored regression comparison between two runs/matrices. */
export interface RegressionComparisonRow {
  id: string;
  user_id: string;
  extension_id: string | null;
  package_version_id_prev: string | null;
  package_version_id_current: string | null;
  test_suite_id: string | null;
  browsers_json: string;
  previous_matrix_run_id: string | null;
  current_matrix_run_id: string | null;
  previous_run_id: string | null;
  current_run_id: string | null;
  result_json: string;
  regression_count: number;
  improvement_count: number;
  created_at: number;
}

export interface ReportRow {
  id: string;
  /** Phase 13: set when the report is pinned (artifact retention respects it). */
  pinned_at?: number | null;
  organization_id?: string | null;
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

/** Phase 6 rows. */
export interface ExtensionPackageRow {
  id: string;
  organization_id?: string | null;
  user_id: string;
  extension_id: string | null;
  storage_key: string;
  sha256: string;
  size: number;
  version: string | null;
  original_name: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

export interface JobRow {
  id: string;
  type: string;
  user_id: string | null;
  organization_id?: string | null;
  status: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  payload_json: string;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  idempotency_key: string | null;
  resource_type: string | null;
  resource_id: string | null;
  worker_id: string | null;
  lease_expires_at: number | null;
  run_after: number;
  cancel_requested_at: number | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface JobEventRow {
  id: number;
  job_id: string;
  kind: string;
  stage: string | null;
  payload: string;
  created_at: number;
}

export interface WorkerRow {
  id: string;
  started_at: number;
  last_seen_at: number;
  concurrency: number;
  active_jobs: number;
  sandbox_available: number | null;
  sandbox_detail: string | null;
  stopping: number;
  /** Phase 13: reported worker version (registration). */
  version: string | null;
  /** Phase 13: capabilities JSON (job types, browsers, resource profiles). */
  capabilities_json: string | null;
  /** Phase 13: first READY heartbeat timestamp (STARTING → READY evidence). */
  ready_at: number | null;
  /** Phase 13: operator scheduling intent: running | draining | disabled. */
  desired_state: string;
}

export interface QuotaReservationRow {
  id: string;
  user_id: string;
  kind: string;
  resource_id: string | null;
  job_id: string | null;
  created_at: number;
  consumed_at: number | null;
  released_at: number | null;
}

export interface ArtifactRow {
  id: string;
  test_run_id: string;
  user_id: string;
  type: string;
  storage_key: string;
  size: number;
  sha256: string;
  content_type: string;
  label: string | null;
  created_at: number;
  expires_at: number;
}

/** Phase 7 rows. */
export interface BillingCustomerRow {
  user_id: string;
  provider: string;
  provider_customer_id: string;
  created_at: number;
  updated_at: number;
}

export interface SubscriptionRow {
  id: string;
  user_id: string;
  provider: string;
  provider_customer_id: string;
  provider_subscription_id: string;
  provider_price_id: string | null;
  plan_id: string;
  status: string;
  current_period_start: number | null;
  current_period_end: number | null;
  cancel_at_period_end: number;
  cancel_at: number | null;
  canceled_at: number | null;
  trial_end: number | null;
  ended_at: number | null;
  last_event_at: number;
  created_at: number;
  updated_at: number;
}

export interface BillingEventRow {
  id: string;
  provider: string;
  provider_event_id: string;
  event_type: string;
  provider_event_type: string;
  user_id: string | null;
  subscription_id: string | null;
  result: string;
  created_at: number;
  processed_at: number | null;
}

export interface CheckoutSessionRow {
  id: string;
  organization_id?: string | null;
  user_id: string;
  provider: string;
  provider_session_id: string;
  plan_id: string;
  status: string;
  created_at: number;
  updated_at: number;
}

/** Phase 8: validated AI result linked to the resource it explains. */
export interface AIResultRow {
  id: string;
  user_id: string;
  feature: string;
  resource_kind: string;
  resource_id: string;
  target_id: string | null;
  provider: string;
  model: string;
  context_hash: string;
  result_json: string;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number;
  created_at: number;
  expires_at: number;
}

// ---------------------------------------------------------------------------
// Phase 10: organizations, public API, webhooks, audit
// ---------------------------------------------------------------------------

export type OrganizationRole = "owner" | "admin" | "developer" | "viewer";

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  owner_user_id: string;
  plan_id: string;
  plan_status: string;
  provider: string | null;
  provider_subscription_id: string | null;
  seats: number;
  settings_json: string;
  created_at: number;
  updated_at: number;
}

export interface OrganizationMemberRow {
  id: string;
  organization_id: string;
  user_id: string;
  role: OrganizationRole;
  created_at: number;
}

export interface OrganizationInvitationRow {
  id: string;
  organization_id: string;
  email: string;
  role: Exclude<OrganizationRole, "owner">;
  token_hash: string;
  invited_by: string;
  expires_at: number;
  accepted_at: number | null;
  accepted_by: string | null;
  revoked_at: number | null;
  resend_count: number;
  created_at: number;
  updated_at: number;
}

export interface OrganizationDomainRow {
  id: string;
  organization_id: string;
  domain: string;
  verification_token: string;
  verified_at: number | null;
  verified_by: string | null;
  created_at: number;
}

export interface OrganizationSsoConfigRow {
  id: string;
  organization_id: string;
  protocol: "oidc" | "saml";
  status: "configured" | "enforced";
  config_json: string;
  created_at: number;
  updated_at: number;
}

export interface OrganizationApiKeyRow {
  id: string;
  organization_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  scopes_json: string;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
}

export interface OrganizationWebhookRow {
  id: string;
  organization_id: string;
  url: string;
  secret: string;
  events_json: string;
  active: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface OrganizationWebhookDeliveryRow {
  id: string;
  organization_id: string;
  webhook_id: string;
  event_id: string;
  event_type: string;
  payload_json: string;
  status: "pending" | "succeeded" | "failed" | "dead_letter";
  attempts: number;
  next_attempt_at: number | null;
  last_status_code: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface OrganizationAuditEventRow {
  id: string;
  organization_id: string;
  actor_user_id: string | null;
  actor_api_key_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  request_id: string | null;
  ip: string | null;
  success: number;
  metadata_json: string;
  created_at: number;
}

export interface ApiIdempotencyRecordRow {
  id: string;
  owner_type: "user" | "organization";
  owner_id: string;
  idempotency_key: string;
  endpoint: string;
  request_hash: string;
  status: "in_flight" | "completed";
  response_status: number | null;
  response_json: string | null;
  created_at: number;
  completed_at: number | null;
  expires_at: number;
}

export interface OrganizationPolicyRow {
  id: string;
  organization_id: string;
  name: string;
  rules_json: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface OrganizationExportRow {
  id: string;
  organization_id: string;
  requested_by: string;
  status: "queued" | "running" | "completed" | "failed" | "expired";
  storage_key: string | null;
  size: number | null;
  sha256: string | null;
  expires_at: number;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface ReportPublicationRow {
  id: string;
  organization_id: string;
  report_id: string;
  slug: string;
  summary: string | null;
  created_by: string;
  created_at: number;
}

/** Phase 11: interactive browser session (durable state; runtime_json is internal). */
export interface InteractiveBrowserSessionRow {
  id: string;
  user_id: string;
  organization_id: string | null;
  extension_id: string | null;
  package_id: string | null;
  package_version: string | null;
  package_sha256: string;
  browser: string;
  browser_version: string | null;
  status: string;
  state_reason: string | null;
  stop_reason: string | null;
  initial_url: string | null;
  current_url: string | null;
  viewport_width: number;
  viewport_height: number;
  popup_open: number;
  popup_width: number | null;
  popup_height: number | null;
  artifact_count: number;
  extension_info_json: string;
  runtime_json: string;
  quota_reservation_id: string | null;
  job_id: string | null;
  request_id: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  ready_at: number | null;
  last_activity_at: number | null;
  expires_at: number;
  stopped_at: number | null;
}

/** Phase 11: bounded structured session event (lifecycle + observed evidence). */
export interface InteractiveSessionEventRow {
  id: string;
  session_id: string;
  seq: number;
  type: string;
  level: string;
  message: string;
  metadata_json: string;
  created_at: number;
}

/** Phase 11: screenshot artifact captured from an interactive browser session. */
export interface BrowserSessionArtifactRow {
  id: string;
  session_id: string;
  user_id: string;
  type: string;
  storage_key: string;
  size: number;
  sha256: string;
  content_type: string;
  label: string | null;
  package_version: string | null;
  package_sha256: string | null;
  browser: string | null;
  browser_version: string | null;
  created_at: number;
  expires_at: number;
}

/** Phase 12: user-marked evidence referencing runtime records (bounded). */
export interface SessionEvidenceRow {
  id: string;
  session_id: string;
  user_id: string;
  organization_id?: string | null;
  kind: "console" | "network" | "event" | "screenshot" | "test_recipe";
  ref_id: string | null;
  label: string | null;
  summary: string;
  metadata_json: string;
  package_id: string | null;
  package_version: string | null;
  package_sha256: string;
  browser: string;
  browser_version: string | null;
  report_id: string | null;
  created_at: number;
}
