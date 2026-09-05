import "server-only";
import { AppError } from "@/lib/observability/errors";
import { consumeReservation, releaseReservation, reserveQuota, QuotaExceededError } from "@/lib/db/repositories/quota";
import { findAIResult, insertAIResult } from "@/lib/db/repositories/ai";
import { getAISettings } from "./config";
import { buildContext, contextHash, type BuildOptions, type ContextSource } from "./context";
import { AIError } from "./errors";
import { acquireSlot } from "./limits";
import { buildPrompt } from "./prompts";
import { getAIProvider, isAIEnabled } from "./provider";
import { parseModelJson, SchemaViolation, validateOutput } from "./schema";
import { ALLOWED_ACTIONS, ALLOWED_ASSERTIONS, ALLOWED_CATEGORIES, ALLOWED_SEVERITIES, maxSuggestedTests, validateSuggestedTest } from "./test-suggestions";
import { AI_DISCLAIMER, type AIContext, type AIFeature, type AIOutput, type AIProvider, type AIProviderResult, type AIResponseEnvelope } from "./types";
import { recordAIRequest, resultForErrorCode, type AIRequestResult } from "./usage";

/**
 * AIService — the single code path every AI feature goes through.
 *
 *   ownership (done by the route via getOwned*) →
 *   context building (allowlist + redaction + budget) →
 *   quota reservation (Phase 7 lifecycle) →
 *   concurrency slot → prompt → provider call with timeout →
 *   strict output validation (+ test-engine validation for suggestions) →
 *   usage accounting, optional persistence, response envelope.
 *
 * Routes never touch providers, prompts or raw model text. A failure at any
 * stage releases the quota reservation (the user is only charged for
 * validated answers) and surfaces as a stable AI_* error code.
 */

export interface AIRequest {
  requestId: string;
  userId: string;
  feature: AIFeature;
  source: ContextSource;
  focus?: BuildOptions["focus"];
  /** Sub-target for caching (finding id, test id, question hash). */
  targetId?: string | null;
}

const FEATURE_METHOD: Record<AIFeature, keyof Pick<AIProvider, "explainFinding" | "explainTestFailure" | "summarizeReport" | "analyzeRuntimeError" | "suggestTests" | "answerReportQuestion">> = {
  explain_finding: "explainFinding",
  explain_test_failure: "explainTestFailure",
  summarize_report: "summarizeReport",
  analyze_runtime_error: "analyzeRuntimeError",
  suggest_tests: "suggestTests",
  answer_report_question: "answerReportQuestion",
};

export async function runAIFeature(request: AIRequest): Promise<AIResponseEnvelope> {
  const startedAt = Date.now();
  const settings = getAISettings();
  const providerName = isAIEnabled() ? settings.provider : "none";
  let context: AIContext | null = null;
  // Model reported in accounting: the provider's own model name (a fake
  // provider must never be logged as if it were the configured real model).
  let modelName: string | null = null;
  try {
    modelName = providerName === "none" ? null : getAIProvider().model;
  } catch {
    modelName = null;
  }

  const finish = (result: AIRequestResult, extra: { model?: string | null; tokens?: AIProviderResult["tokens"]; errorCode?: string } = {}) =>
    recordAIRequest({
      requestId: request.requestId,
      userId: request.userId,
      feature: request.feature,
      provider: providerName,
      model: extra.model ?? modelName,
      durationMs: Date.now() - startedAt,
      result,
      tokens: extra.tokens,
      contextBytes: context?.bytes,
      truncated: context?.truncated,
      errorCode: extra.errorCode,
    });

  try {
    if (!isAIEnabled()) throw new AIError("AI_NOT_CONFIGURED");
    const provider = getAIProvider();

    // 1. Sanitized context (also verifies the focus target belongs to the resource).
    context = buildContext(request.source, { feature: request.feature, maxBytes: settings.maxContextBytes, focus: request.focus });
    const hash = contextHash(context);
    const lookup = {
      userId: request.userId,
      feature: request.feature,
      resourceKind: request.source.resource.kind,
      resourceId: request.source.resource.id,
      targetId: request.targetId ?? null,
      contextHash: hash,
    };

    // 2. Cache: identical evidence for the same owner → same validated answer, no quota charge.
    if (settings.resultRetentionMs > 0) {
      const cached = findAIResult(lookup);
      if (cached) {
        const result = JSON.parse(cached.result_json) as AIOutput;
        finish("cached", { model: cached.model });
        return envelope(request.feature, result, { provider: cached.provider as AIResponseEnvelope["meta"]["provider"], model: cached.model, cached: true, durationMs: Date.now() - startedAt, createdAt: cached.created_at });
      }
    }

    // 3. Quota reservation (plan + period aware; atomic).
    const reservation = reserveQuota({ userId: request.userId, kind: "ai_request", resourceId: request.source.resource.id });
    let slot: ReturnType<typeof acquireSlot> | null = null;
    try {
      slot = acquireSlot(request.userId, { global: settings.maxConcurrency, perUser: settings.maxConcurrencyPerUser });
      const prompt = buildPrompt(request.feature, context, {
        maxOutputTokens: settings.maxOutputTokens,
        allowedActions: ALLOWED_ACTIONS,
        allowedAssertions: ALLOWED_ASSERTIONS,
        allowedCategories: ALLOWED_CATEGORIES,
        allowedSeverities: ALLOWED_SEVERITIES,
        maxSuggestedTests: maxSuggestedTests(),
        maxTestTimeoutMs: 10_000,
      });

      // 4. Provider call with a hard timeout.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
      let raw: AIProviderResult;
      try {
        raw = await withTimeout(
          provider[FEATURE_METHOD[request.feature]](prompt, { signal: controller.signal, timeoutMs: settings.timeoutMs, requestId: request.requestId }),
          settings.timeoutMs,
        );
      } finally {
        clearTimeout(timer);
      }

      // 5. Strict validation. Model text is never returned unvalidated.
      if (typeof raw.text !== "string" || raw.text.trim() === "") throw new AIError("AI_INVALID_OUTPUT", { cause: { reason: "empty" } });
      if (raw.text.length > settings.maxResponseBytes) throw new AIError("AI_INVALID_OUTPUT", { cause: { reason: "response_too_large" } });
      let output: AIOutput;
      try {
        output = validateOutput(request.feature, parseModelJson(raw.text), context, validateSuggestedTest);
      } catch (error) {
        if (error instanceof SchemaViolation) throw new AIError("AI_INVALID_OUTPUT", { cause: { violation: error.path } });
        throw error;
      }

      // 6. Charge quota only now, persist the validated result, respond.
      consumeReservation(reservation.id);
      const durationMs = Date.now() - startedAt;
      const createdAt = Date.now();
      if (settings.resultRetentionMs > 0) {
        insertAIResult({
          ...lookup,
          provider: provider.name,
          model: raw.model,
          resultJson: JSON.stringify(output),
          inputTokens: raw.tokens.input,
          outputTokens: raw.tokens.output,
          durationMs,
          expiresAt: createdAt + settings.resultRetentionMs,
        });
      }
      finish("success", { model: raw.model, tokens: raw.tokens });
      return envelope(request.feature, output, { provider: provider.name, model: raw.model, cached: false, durationMs, createdAt });
    } catch (error) {
      releaseReservation(reservation.id);
      throw error;
    } finally {
      slot?.release();
    }
  } catch (error) {
    const normalized = normalizeError(error);
    const code = normalized instanceof QuotaExceededError ? "AI_QUOTA_EXCEEDED" : normalized.code;
    finish(resultForErrorCode(code), { errorCode: code });
    throw normalized;
  }
}

function envelope(feature: AIFeature, result: AIOutput, meta: Omit<AIResponseEnvelope["meta"], "disclaimer">): AIResponseEnvelope {
  return { feature, result, meta: { ...meta, disclaimer: AI_DISCLAIMER } };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AIError("AI_TIMEOUT")), timeoutMs + 250);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Every failure leaves the service with a stable code. Quota denials keep
 * their structured details (usage, limit, reset, required plan) so the API
 * layer can render the paywall exactly as for analyses and test runs.
 */
function normalizeError(error: unknown): AppError | QuotaExceededError {
  if (error instanceof AppError || error instanceof QuotaExceededError) return error;
  if (error && typeof error === "object" && (error as { name?: string }).name === "AbortError") return new AIError("AI_TIMEOUT", { cause: error });
  return new AIError("AI_UNAVAILABLE", { cause: error });
}
