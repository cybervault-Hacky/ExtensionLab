/**
 * Retry policy: exponential backoff 1s, 2s, 4s, 8s … capped. Only errors
 * classified as transient are retried; validation errors, quota errors and
 * user cancellations are never retried.
 */

import { classifyError, type ErrorCode } from "@/lib/observability/errors";

export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 60_000;

export function backoffDelay(attempt: number, opts: { baseMs?: number; maxMs?: number; jitter?: boolean } = {}): number {
  const base = opts.baseMs ?? RETRY_BASE_MS;
  const max = opts.maxMs ?? RETRY_MAX_MS;
  const exponent = Math.max(0, attempt - 1);
  const raw = Math.min(max, base * 2 ** exponent);
  if (opts.jitter === false) return raw;
  // Up to 10% jitter to avoid thundering herds; never above the cap.
  const jitter = Math.floor(Math.random() * raw * 0.1);
  return Math.min(max, raw + jitter);
}

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
  code: ErrorCode;
  userMessage: string;
}

export function decideRetry(error: unknown, attempt: number, maxAttempts: number): RetryDecision {
  const classified = classifyError(error);
  const canRetry = classified.retryable && attempt < maxAttempts;
  return {
    retry: canRetry,
    delayMs: canRetry ? backoffDelay(attempt) : 0,
    code: classified.code,
    userMessage: classified.userMessage,
  };
}
