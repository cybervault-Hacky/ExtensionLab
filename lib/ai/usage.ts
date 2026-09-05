import "server-only";
import { logger, recordMetric } from "@/lib/observability/logger";
import type { AIFeature, AIProviderName, AIUsageTokens } from "./types";

/**
 * Aggregate usage accounting and structured logging for AI calls.
 *
 * Quota consumption itself is handled by the Phase 7 reservation lifecycle
 * (`reserveQuota("ai_request")` → consume/release) — this module only emits
 * the operational signals: one log line per request with feature, provider,
 * model, duration, result and token counts, plus metrics. Prompts, responses,
 * context, keys and cookies are never part of these records.
 */

export type AIRequestResult =
  | "success"
  | "cached"
  | "timeout"
  | "provider_error"
  | "rate_limited"
  | "quota_exceeded"
  | "plan_denied"
  | "invalid_output"
  | "context_too_large"
  | "not_configured"
  | "unavailable"
  | "unauthorized_context"
  | "invalid_input"
  | "error";

export interface AIRequestRecord {
  requestId: string;
  userId: string;
  feature: AIFeature;
  provider: AIProviderName | "none";
  model: string | null;
  durationMs: number;
  result: AIRequestResult;
  tokens?: AIUsageTokens;
  contextBytes?: number;
  truncated?: boolean;
  errorCode?: string;
}

const METRIC_BY_RESULT: Partial<Record<AIRequestResult, string>> = {
  success: "ai.success",
  cached: "ai.cache_hit",
  timeout: "ai.timeout",
  provider_error: "ai.provider_error",
  rate_limited: "ai.rate_limited",
  quota_exceeded: "ai.quota_rejected",
  plan_denied: "ai.plan_rejected",
  invalid_output: "ai.invalid_output",
  context_too_large: "ai.context_too_large",
  not_configured: "ai.not_configured",
  unavailable: "ai.unavailable",
  unauthorized_context: "ai.unauthorized_context",
};

export function recordAIRequest(record: AIRequestRecord): void {
  const tags = { feature: record.feature, provider: record.provider, result: record.result };
  recordMetric("ai.request", 1, tags);
  const specific = METRIC_BY_RESULT[record.result];
  if (specific) recordMetric(specific, 1, tags);
  recordMetric("ai.duration_ms", record.durationMs, tags);
  if (record.tokens?.input !== null && record.tokens?.input !== undefined) recordMetric("ai.tokens_input", record.tokens.input, tags);
  if (record.tokens?.output !== null && record.tokens?.output !== undefined) recordMetric("ai.tokens_output", record.tokens.output, tags);

  const level = record.result === "success" || record.result === "cached" ? "info" : record.result === "error" || record.result === "provider_error" ? "error" : "warn";
  logger[level]("ai.request", {
    requestId: record.requestId,
    userId: record.userId,
    feature: record.feature,
    provider: record.provider,
    model: record.model ?? undefined,
    durationMs: record.durationMs,
    result: record.result,
    errorCode: record.errorCode,
    inputTokens: record.tokens?.input ?? undefined,
    outputTokens: record.tokens?.output ?? undefined,
    contextBytes: record.contextBytes,
    truncated: record.truncated,
  });
}

/** Maps an error code from the catalog onto the aggregate result bucket. */
export function resultForErrorCode(code: string | undefined): AIRequestResult {
  switch (code) {
    case "AI_TIMEOUT":
      return "timeout";
    case "AI_PROVIDER_ERROR":
      return "provider_error";
    case "AI_RATE_LIMITED":
    case "RATE_LIMITED":
      return "rate_limited";
    case "AI_QUOTA_EXCEEDED":
    case "QUOTA_EXCEEDED":
      return "quota_exceeded";
    case "PAYMENT_REQUIRED":
      return "plan_denied";
    case "AI_INVALID_OUTPUT":
      return "invalid_output";
    case "AI_CONTEXT_TOO_LARGE":
      return "context_too_large";
    case "AI_NOT_CONFIGURED":
      return "not_configured";
    case "AI_UNAVAILABLE":
      return "unavailable";
    case "AI_UNAUTHORIZED_CONTEXT":
    case "NOT_FOUND":
      return "unauthorized_context";
    case "INVALID_INPUT":
      return "invalid_input";
    default:
      return "error";
  }
}
