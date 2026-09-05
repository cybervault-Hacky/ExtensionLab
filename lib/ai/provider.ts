import "server-only";
import { getConfig } from "@/lib/config/env";
import { AIError } from "./errors";
import type { AIProvider } from "./types";
import { createOpenAIProvider } from "./providers/openai";
import { createFakeAIProvider, type FakeAIProvider } from "./providers/fake";

/**
 * Provider registry. The service obtains the provider only through
 * `getAIProvider()`; which adapter is behind it is decided by validated
 * configuration:
 *
 *   AI_PROVIDER=openai   → OpenAI-compatible adapter (AI_API_KEY required)
 *   AI_PROVIDER=fake     → deterministic fake (rejected in production)
 *   AI_PROVIDER=disabled → every AI route answers AI_NOT_CONFIGURED
 *
 * Production never falls back to the fake provider: a misconfiguration is a
 * closed door, not a silent downgrade.
 */

let cached: { provider: AIProvider; configRef: ReturnType<typeof getConfig> } | null = null;
let testOverride: AIProvider | null = null;

export function isAIEnabled(): boolean {
  if (testOverride) return true;
  const config = getConfig();
  if (config.ai.provider === "disabled") return false;
  if (config.ai.provider === "fake") return config.appEnv !== "production";
  return Boolean(config.ai.apiKey);
}

export function getAIProvider(): AIProvider {
  if (testOverride) return testOverride;
  const config = getConfig();
  if (cached && cached.configRef === config) return cached.provider;
  const ai = config.ai;
  let provider: AIProvider;
  switch (ai.provider) {
    case "openai":
      if (!ai.apiKey) throw new AIError("AI_NOT_CONFIGURED");
      provider = createOpenAIProvider({ apiKey: ai.apiKey, model: ai.model, baseUrl: ai.baseUrl, maxResponseBytes: ai.maxResponseBytes });
      break;
    case "fake":
      if (config.appEnv === "production") throw new AIError("AI_NOT_CONFIGURED");
      provider = createFakeAIProvider({ model: ai.model === "gpt-4o-mini" ? "fake-deterministic-1" : ai.model });
      break;
    default:
      throw new AIError("AI_NOT_CONFIGURED");
  }
  cached = { provider, configRef: config };
  return provider;
}

/** The fake provider instance when it is active (dev tooling / tests). */
export function getFakeAIProvider(): FakeAIProvider | null {
  const provider = testOverride ?? (isAIEnabled() ? getAIProvider() : null);
  return provider && provider.name === "fake" ? (provider as FakeAIProvider) : null;
}

/** Test helper: pin a provider instance regardless of configuration. */
export function setAIProviderForTests(provider: AIProvider | null): void {
  testOverride = provider;
  cached = null;
}
