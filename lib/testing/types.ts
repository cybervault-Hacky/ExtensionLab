/**
 * Phase 4 automated testing types.
 *
 * The test engine is intentionally deterministic. Automated tests execute only
 * predefined browser actions inside the Phase 3 disposable sandbox; no
 * arbitrary JavaScript, CDP commands, shell commands, or host execution are
 * possible.
 */

export type TestStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "warning"
  | "skipped"
  | "timeout"
  | "error";

export type TestCategory =
  | "manifest"
  | "loading"
  | "page"
  | "content_script"
  | "popup"
  | "background"
  | "service_worker"
  | "permissions"
  | "console"
  | "network"
  | "storage"
  | "performance"
  | "security";

export type TestSeverity = "info" | "low" | "medium" | "high" | "critical";

export type TestRunState =
  | "idle"
  | "queued"
  | "preparing"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "stopping"
  | "destroyed";

/**
 * Human-readable pipeline stages (Phase 6). Stages are reported as they
 * actually happen; the UI never derives a fabricated percentage from them.
 */
export type TestRunStage =
  | "Queued"
  | "Preparing"
  | "Starting sandbox"
  | "Starting Chromium"
  | "Loading extension"
  | "Running tests"
  | "Collecting evidence"
  | "Generating report"
  | "Completed";

/** Final semantic outcome of a run. */
export type TestRunOutcome =
  | "PASSED"
  | "FAILED"
  | "WARNING"
  | "SKIPPED"
  | "TIMEOUT"
  | "INFRASTRUCTURE_ERROR"
  | "CANCELLED";

export type TestActionType =
  | "open_url"
  | "reload_page"
  | "wait"
  | "click"
  | "type"
  | "select"
  | "scroll"
  | "inspect_text"
  | "inspect_element"
  | "open_popup"
  | "clear_console"
  | "capture_screenshot";

export interface TestAction {
  type: TestActionType;
  selector?: string;
  value?: string;
  milliseconds?: number;
  url?: string;
}

export type AssertionType =
  | "element_exists"
  | "element_visible"
  | "text_contains"
  | "url_equals"
  | "url_contains"
  | "console_contains"
  | "console_not_contains"
  | "network_request_seen"
  | "network_status_equals"
  | "extension_loaded"
  | "content_script_detected"
  | "service_worker_detected"
  | "popup_available"
  | "runtime_error_none"
  | "network_4xx_none"
  | "network_5xx_none";

export interface TestAssertion {
  type: AssertionType;
  selector?: string;
  value?: string;
  expectedStatus?: number;
  message?: string;
}

export interface TestEvidence {
  id: string;
  timestamp: number;
  kind: "console" | "network" | "runtime" | "screenshot" | "page" | "action" | "result";
  label: string;
  detail?: string;
}

export interface AssertionOutcome {
  assertion: TestAssertion;
  passed: boolean;
  message: string;
}

export interface TestResult {
  testId: string;
  name: string;
  description: string;
  category: TestCategory;
  status: TestStatus;
  duration: number;
  startedAt: number;
  finishedAt: number;
  steps: string[];
  assertions: AssertionOutcome[];
  evidence: TestEvidence[];
  errors: string[];
  warnings: string[];
  skippedReason?: string;
  runId?: string;
}

export interface TestCaseInput {
  id: string;
  name: string;
  description: string;
  category: TestCategory;
  severity: TestSeverity;
  timeout: number;
  steps: TestAction[];
  assertions: TestAssertion[];
  applicable: (context: TestDiscoveryContext) => boolean;
  skipReason?: string;
}

export interface TestCase extends Omit<TestCaseInput, "applicable"> {
  applicable: (context: TestDiscoveryContext) => boolean;
}

export interface TestSuiteInput {
  id: string;
  name: string;
  description: string;
  tests: TestCase[];
}

export interface TestSuite {
  id: string;
  name: string;
  description: string;
  tests: TestCase[];
}

export interface TestDiscoveryContext {
  manifestVersion: "v3" | "v2" | "unknown";
  hasPopup: boolean;
  hasContentScripts: boolean;
  hasServiceWorker: boolean;
  hasBackground: boolean;
  hasWebAccessibleResources: boolean;
  permissions: string[];
  hostPermissions: string[];
  broadHostPermissions: boolean;
  sourceHasRuntimeIssue?: boolean;
}

export interface TestRunInfo {
  runId: string;
  sandboxId?: string;
  state: TestRunState;
  queuePosition?: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  total: number;
  completed: number;
  passed: number;
  failed: number;
  warning: number;
  skipped: number;
  timeout: number;
  error: number;
  score: number;
  reason?: string;
  /** Phase 6: current pipeline stage. */
  stage?: TestRunStage;
  /** Phase 6: final semantic outcome; absent while the run is active. */
  outcome?: TestRunOutcome;
  /** Phase 6: stable error code when the run ended abnormally. */
  errorCode?: string;
  /** Phase 6: background job id (safe to expose; non-guessable). */
  jobId?: string;
}

export interface CapturedScreenshot {
  testId: string;
  capturedAt: number;
  bytes: Uint8Array;
}

export interface TestRunSnapshot {
  runId: string;
  token: string;
  sandboxId?: string;
  /** Session token of the sandbox created for this run (never exposed). */
  sandboxToken?: string;
  sourcePath: string;
  testUrl?: string;
  tests?: TestCase[];
  state: TestRunState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  expiresAt: number;
  total: number;
  results: TestResult[];
  events: string[];
  diagnostics: DiagnosticFinding[];
  score: TestScore;
  reason?: string;
  /** Phase 6 additions. */
  stage?: TestRunStage;
  errorCode?: string;
  screenshots?: CapturedScreenshot[];
  network?: NetworkEntryLike[];
  runtimeEvents?: RuntimeEventLike[];
}

export interface TestScoreCategory {
  key: string;
  label: string;
  score: number;
  applicable: boolean;
}

export interface TestScore {
  total: number;
  passed: number;
  failed: number;
  warning: number;
  skipped: number;
  timeout: number;
  error: number;
  categories: TestScoreCategory[];
  basis: string;
}

export type DiagnosticSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface DiagnosticFinding {
  id: string;
  severity: DiagnosticSeverity;
  category: TestCategory | "runtime" | "report" | "stability";
  title: string;
  description: string;
  evidence: string[];
  relatedTestId?: string;
  sourceFile?: string;
  recommendation: string;
}

export interface AssertionContext {
  url?: string;
  consoleEvents: RuntimeEventLike[];
  networkEntries: NetworkEntryLike[];
  extensionLoaded: boolean;
  contentScriptDetected: boolean;
  serviceWorkerDetected: boolean;
  popupAvailable: boolean;
  currentElement?: { exists: boolean; visible: boolean; text?: string };
  currentElementSelector?: string;
  currentTextInspection?: string;
}

export interface RuntimeEventLike {
  id: string;
  timestamp: number;
  type: string;
  level: string;
  source: string;
  message: string;
}

export interface NetworkEntryLike {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  status: number | null;
  resourceType: string;
  duration: number;
}
