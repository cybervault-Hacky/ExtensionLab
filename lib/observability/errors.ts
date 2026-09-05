/**
 * Stable error catalog.
 *
 * Every user-facing failure maps to one of these codes. Codes are stable
 * identifiers that operators can grep for in logs and that clients can rely
 * on. Messages are safe for end users: no stack traces, paths, container ids,
 * hostnames or provider details.
 */

export const ERROR_CATALOG = {
  AUTH_REQUIRED: { status: 401, message: "Sign in to continue.", retryable: false },
  FORBIDDEN: { status: 403, message: "You don't have permission to access this resource.", retryable: false },
  NOT_FOUND: { status: 404, message: "Resource not found.", retryable: false },
  INVALID_INPUT: { status: 400, message: "The request could not be processed.", retryable: false },
  INVALID_EXTENSION: { status: 400, message: "This extension package could not be validated.", retryable: false },
  STORAGE_ERROR: { status: 503, message: "The package could not be stored. Please try again.", retryable: true },
  JOB_TIMEOUT: { status: 504, message: "The job exceeded its time limit.", retryable: false },
  JOB_CANCELLED: { status: 409, message: "The job was cancelled.", retryable: false },
  SANDBOX_UNAVAILABLE: { status: 503, message: "The isolated browser environment is currently unavailable.", retryable: true },
  SANDBOX_TIMEOUT: { status: 504, message: "The isolated browser did not respond in time.", retryable: false },
  EXTENSION_LOAD_FAILED: { status: 422, message: "The extension could not be loaded in the isolated browser.", retryable: false },
  TEST_FAILED: { status: 200, message: "One or more automated tests failed.", retryable: false },
  QUOTA_EXCEEDED: { status: 429, message: "Your plan limit has been reached.", retryable: false },
  CONCURRENCY_LIMIT: { status: 429, message: "Another run is already active. Please wait for it to finish.", retryable: true },
  QUEUE_FULL: { status: 503, message: "The test queue is full. Please try again shortly.", retryable: true },
  RATE_LIMITED: { status: 429, message: "Too many requests. Please try again later.", retryable: true },
  CONFLICT: { status: 409, message: "This action conflicts with the current state.", retryable: false },
  EMAIL_DELIVERY_FAILED: { status: 503, message: "The message could not be delivered.", retryable: true },
  WORKER_UNAVAILABLE: { status: 503, message: "Background processing is currently unavailable.", retryable: true },
  // Phase 7 billing.
  BILLING_NOT_CONFIGURED: { status: 503, message: "Billing is not available on this deployment.", retryable: false },
  BILLING_PROVIDER_ERROR: { status: 502, message: "The billing provider could not complete the request. Please try again.", retryable: true },
  CHECKOUT_CREATION_FAILED: { status: 502, message: "We couldn't start checkout. Please try again.", retryable: true },
  INVALID_PLAN: { status: 400, message: "This plan is not available.", retryable: false },
  SUBSCRIPTION_NOT_FOUND: { status: 404, message: "No subscription was found for this account.", retryable: false },
  SUBSCRIPTION_STATE_INVALID: { status: 409, message: "This action is not possible in the subscription's current state.", retryable: false },
  WEBHOOK_SIGNATURE_INVALID: { status: 400, message: "The webhook signature could not be verified.", retryable: false },
  PAYMENT_REQUIRED: { status: 402, message: "This feature requires a paid plan.", retryable: false },
  // Phase 9 cross-browser testing.
  BROWSER_RUNTIME_UNAVAILABLE: { status: 503, message: "This browser runtime is not available on this deployment.", retryable: false },
  BROWSER_NOT_SUPPORTED: { status: 400, message: "This browser is not supported for testing.", retryable: false },
  MATRIX_LIMIT: { status: 400, message: "The browser matrix exceeds the configured limits.", retryable: false },
  // Phase 8 AI assistance. Messages are the exact strings the UI shows; none
  // of them reveal the provider, the model or any request/response content.
  AI_NOT_CONFIGURED: { status: 503, message: "AI assistance is currently unavailable.", retryable: false },
  AI_UNAVAILABLE: { status: 503, message: "AI analysis is temporarily unavailable.", retryable: true },
  AI_PROVIDER_ERROR: { status: 502, message: "AI analysis is temporarily unavailable.", retryable: true },
  AI_TIMEOUT: { status: 504, message: "AI analysis took too long. Please try again.", retryable: true },
  AI_RATE_LIMITED: { status: 429, message: "Too many AI requests. Please wait a moment and try again.", retryable: true },
  AI_QUOTA_EXCEEDED: { status: 429, message: "AI usage limit reached.", retryable: false },
  AI_INVALID_OUTPUT: { status: 502, message: "The AI response could not be validated. Please try again.", retryable: true },
  AI_CONTEXT_TOO_LARGE: { status: 413, message: "There is too much data for a single AI analysis.", retryable: false },
  AI_UNAUTHORIZED_CONTEXT: { status: 404, message: "Resource not found.", retryable: false },
  // Phase 10 organizations, public API, webhooks.
  ORGANIZATION_NOT_FOUND: { status: 404, message: "Organization not found.", retryable: false },
  ORGANIZATION_ACCESS_DENIED: { status: 403, message: "You don't have access to this organization.", retryable: false },
  ROLE_REQUIRED: { status: 403, message: "Your role does not permit this action.", retryable: false },
  INVITATION_EXPIRED: { status: 410, message: "This invitation has expired.", retryable: false },
  INVITATION_REVOKED: { status: 410, message: "This invitation is no longer valid.", retryable: false },
  INVITATION_INVALID: { status: 404, message: "This invitation could not be found.", retryable: false },
  SEAT_LIMIT_REACHED: { status: 409, message: "All seats for this organization are in use.", retryable: false },
  API_KEY_INVALID: { status: 401, message: "The API key is invalid.", retryable: false },
  API_KEY_EXPIRED: { status: 401, message: "The API key has expired.", retryable: false },
  API_SCOPE_DENIED: { status: 403, message: "The API key is missing a required scope.", retryable: false },
  API_DISABLED: { status: 404, message: "The public API is not available on this deployment.", retryable: false },
  IDEMPOTENCY_CONFLICT: { status: 409, message: "This idempotency key was already used with a different request.", retryable: false },
  WEBHOOK_DESTINATION_BLOCKED: { status: 400, message: "This webhook destination is not allowed.", retryable: false },
  WEBHOOK_DELIVERY_FAILED: { status: 502, message: "The webhook could not be delivered.", retryable: true },
  EXPORT_NOT_READY: { status: 409, message: "The export is not ready yet.", retryable: true },
  POLICY_FAILED: { status: 200, message: "The quality gates for this organization were not met.", retryable: false },
  SSO_NOT_CONFIGURED: { status: 404, message: "Single sign-on is not configured for this organization.", retryable: false },
  SSO_NOT_ENABLED: { status: 404, message: "Single sign-on is not available on this deployment.", retryable: false },
  INTERNAL: { status: 500, message: "The request could not be completed.", retryable: false },
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ERROR_CATALOG, value);
}

/**
 * Application error with a stable code. `retryable` marks transient failures
 * (the job system only retries those). `userMessage` is safe to show.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly userMessage: string;
  /** For RATE_LIMITED: seconds until the caller may retry. */
  readonly retryAfterSeconds?: number;
  readonly cause?: unknown;

  constructor(code: ErrorCode, options: { message?: string; retryable?: boolean; cause?: unknown; retryAfterSeconds?: number } = {}) {
    const entry = ERROR_CATALOG[code];
    super(options.message ?? entry.message);
    this.name = "AppError";
    this.code = code;
    this.status = entry.status;
    this.retryable = options.retryable ?? entry.retryable;
    this.userMessage = options.message ?? entry.message;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.cause = options.cause;
  }
}

/** Legacy Phase 5 `ApiError` codes mapped onto the stable catalog. */
export const LEGACY_CODE_MAP: Record<string, ErrorCode> = {
  unauthorized: "AUTH_REQUIRED",
  forbidden: "FORBIDDEN",
  not_found: "NOT_FOUND",
  bad_request: "INVALID_INPUT",
  invalid_input: "INVALID_INPUT",
  rate_limited: "RATE_LIMITED",
  limit_reached: "QUOTA_EXCEEDED",
  conflict: "CONFLICT",
  internal: "INTERNAL",
  environment_unavailable: "SANDBOX_UNAVAILABLE",
  runner_unavailable: "SANDBOX_UNAVAILABLE",
  capacity_reached: "CONCURRENCY_LIMIT",
  extension_load_failed: "EXTENSION_LOAD_FAILED",
  invalid_extension: "INVALID_EXTENSION",
  timeout: "SANDBOX_TIMEOUT",
};

export function toErrorCode(value: unknown): ErrorCode {
  if (isErrorCode(value)) return value;
  if (typeof value === "string" && LEGACY_CODE_MAP[value]) return LEGACY_CODE_MAP[value];
  return "INTERNAL";
}

/**
 * Classifies an arbitrary thrown value. Unknown errors are never retried and
 * never surface their message to users.
 */
export function classifyError(error: unknown): { code: ErrorCode; retryable: boolean; userMessage: string } {
  if (error instanceof AppError) {
    return { code: error.code, retryable: error.retryable, userMessage: error.userMessage };
  }
  if (error && typeof error === "object") {
    const record = error as { code?: unknown; message?: unknown; name?: unknown };
    const code = toErrorCode(record.code);
    if (code !== "INTERNAL") {
      return { code, retryable: ERROR_CATALOG[code].retryable, userMessage: ERROR_CATALOG[code].message };
    }
    if (record.code === "ETIMEDOUT" || record.code === "ECONNRESET" || record.code === "EAI_AGAIN" || record.code === "ECONNREFUSED") {
      return { code: "SANDBOX_UNAVAILABLE", retryable: true, userMessage: ERROR_CATALOG.SANDBOX_UNAVAILABLE.message };
    }
    if (record.code === "ENOSPC" || record.code === "EIO" || record.code === "EBUSY") {
      return { code: "STORAGE_ERROR", retryable: true, userMessage: ERROR_CATALOG.STORAGE_ERROR.message };
    }
  }
  return { code: "INTERNAL", retryable: false, userMessage: ERROR_CATALOG.INTERNAL.message };
}

/**
 * Removes anything that could identify hosts, paths, containers or secrets
 * from a diagnostic message before it is stored or logged.
 */
export function scrubDiagnostic(message: string): string {
  return message
    .replace(/[A-Za-z]:\\[^\s]+/g, "[path]")
    .replace(/\/(?:private|var|tmp|home|app|usr|etc|data|Users)\/[^\s'")]+/g, "[path]")
    .replace(/\b[0-9a-f]{64}\b/g, "[id]")
    .replace(/\b[0-9a-f]{12,}\b/g, "[id]")
    .replace(/([A-Z_]{2,}=)[^\s]+/g, "$1[redacted]")
    .replace(/(bearer\s+)[a-z0-9._\-]+/gi, "$1[redacted]")
    .replace(/\bat\s+[\w:./<>\-]+(\s+\(.*?\))?/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
