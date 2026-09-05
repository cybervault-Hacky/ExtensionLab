import "server-only";
import { getConfig } from "@/lib/config/env";
import type { AIProviderName } from "./types";

/**
 * Server-side view of the AI configuration. Everything except the API key is
 * safe to log; the key is only ever read by `lib/ai/provider.ts` when it
 * instantiates the production adapter.
 */
export interface AISettings {
  provider: AIProviderName;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  maxRequestBytes: number;
  maxContextBytes: number;
  maxOutputTokens: number;
  maxResponseBytes: number;
  maxConcurrency: number;
  maxConcurrencyPerUser: number;
  resultRetentionMs: number;
  /** True when a provider is selected and (for real providers) credentials exist. */
  configured: boolean;
}

export function getAISettings(): AISettings {
  const { ai, appEnv } = getConfig();
  const configured =
    ai.provider === "fake" ? appEnv !== "production" : ai.provider === "openai" ? Boolean(ai.apiKey) : false;
  return {
    provider: ai.provider,
    model: ai.model,
    baseUrl: ai.baseUrl,
    timeoutMs: ai.timeoutMs,
    maxRequestBytes: ai.maxRequestBytes,
    maxContextBytes: ai.maxContextBytes,
    maxOutputTokens: ai.maxOutputTokens,
    maxResponseBytes: ai.maxResponseBytes,
    maxConcurrency: ai.maxConcurrency,
    maxConcurrencyPerUser: ai.maxConcurrencyPerUser,
    resultRetentionMs: ai.resultRetentionDays * 24 * 60 * 60 * 1000,
    configured,
  };
}

/** Public, secret-free capability flag for readiness output and the UI. */
export function isAIConfigured(): boolean {
  return getAISettings().configured;
}
