import "server-only";
import { classifyError, type ErrorCode } from "./errors";

/**
 * Phase 13 §25: explicit failure classes shared by jobs, sessions, admin
 * views and alerting. Not every failure is a "server error" — mapping every
 * error code to one of these classes keeps reporting, retries and alerts
 * honest and actionable.
 */

export type FailureClass =
  | "USER_ERROR"
  | "PACKAGE_ERROR"
  | "EXTENSION_ERROR"
  | "BROWSER_ERROR"
  | "WORKER_ERROR"
  | "STORAGE_ERROR"
  | "QUEUE_ERROR"
  | "INFRASTRUCTURE_ERROR"
  | "TIMEOUT"
  | "CANCELLED"
  | "QUOTA_EXCEEDED"
  | "UNSUPPORTED"
  | "AUTH_ERROR";

const CLASS_BY_CODE: Partial<Record<ErrorCode, FailureClass>> = {
  INVALID_INPUT: "USER_ERROR",
  UNSAFE_URL: "USER_ERROR",
  PACKAGE_UNAVAILABLE: "PACKAGE_ERROR",
  EXTENSION_LOAD_FAILED: "EXTENSION_ERROR",
  TEST_FAILED: "EXTENSION_ERROR",
  BROWSER_UNAVAILABLE: "BROWSER_ERROR",
  BROWSER_SESSION_START_FAILED: "BROWSER_ERROR",
  SANDBOX_UNAVAILABLE: "BROWSER_ERROR",
  WORKER_UNAVAILABLE: "WORKER_ERROR",
  JOB_TIMEOUT: "TIMEOUT",
  SANDBOX_TIMEOUT: "TIMEOUT",
  JOB_CANCELLED: "CANCELLED",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  CONCURRENCY_LIMIT: "QUOTA_EXCEEDED",
  QUEUE_FULL: "QUEUE_ERROR",
  STORAGE_ERROR: "STORAGE_ERROR",
  AI_NOT_CONFIGURED: "UNSUPPORTED",
  AUTH_REQUIRED: "AUTH_ERROR",
  FORBIDDEN: "AUTH_ERROR",
  NOT_FOUND: "AUTH_ERROR",
};

/** Map any thrown value to its failure class (default: INFRASTRUCTURE_ERROR). */
export function failureClassOf(error: unknown): FailureClass {
  const { code } = classifyError(error);
  return classForCode(code);
}

export function classForCode(code: ErrorCode | string | null | undefined): FailureClass {
  if (!code) return "INFRASTRUCTURE_ERROR";
  const mapped = CLASS_BY_CODE[code as ErrorCode];
  if (mapped) return mapped;
  // Remaining codes are internal/infra-shaped (rate limits, conflicts, db…).
  if (code === "RATE_LIMITED") return "QUOTA_EXCEEDED";
  if (code === "INTERNAL") return "INFRASTRUCTURE_ERROR";
  return "INFRASTRUCTURE_ERROR";
}

/** Stable grouping key for admin failure views (§56). */
export function failureGroupLabel(failureClass: FailureClass): string {
  return failureClass.toLowerCase();
}
