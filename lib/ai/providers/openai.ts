import { AIError } from "../errors";
import type { AIPrompt, AIProvider, AIProviderRequestOptions, AIProviderResult } from "../types";

/**
 * Production adapter for OpenAI-compatible chat-completions APIs
 * (OpenAI itself, Azure/OpenRouter/self-hosted gateways that speak the same
 * protocol via AI_BASE_URL).
 *
 * The adapter is deliberately thin: it sends the centrally built prompt,
 * enforces timeout and response-size limits, maps failures onto the stable
 * error catalog and returns the model text. It never logs the prompt, the
 * response or the key; the key lives in a closure and is only used for the
 * Authorization header.
 */

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxResponseBytes: number;
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  model?: unknown;
}

export function createOpenAIProvider(options: OpenAIProviderOptions): AIProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  async function complete(prompt: AIPrompt, request: AIProviderRequestOptions): Promise<AIProviderResult> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    request.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
            "x-request-id": request.requestId,
          },
          body: JSON.stringify({
            model: options.model,
            temperature: 0.2,
            max_tokens: prompt.maxOutputTokens,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: prompt.system },
              { role: "user", content: prompt.user },
            ],
          }),
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        if (controller.signal.aborted) throw new AIError("AI_TIMEOUT", { cause: error });
        throw new AIError("AI_PROVIDER_ERROR", { cause: error });
      }

      if (response.status === 429) throw new AIError("AI_RATE_LIMITED", { message: "The AI provider is rate limiting requests. Please try again shortly." });
      if (response.status === 408 || response.status === 504) throw new AIError("AI_TIMEOUT");
      if (!response.ok) {
        // 401/403 = misconfigured key; still a generic provider error for clients.
        throw new AIError("AI_PROVIDER_ERROR", { cause: { status: response.status } });
      }

      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > options.maxResponseBytes) {
        throw new AIError("AI_INVALID_OUTPUT", { cause: { reason: "response_too_large" } });
      }
      const text = await readBounded(response, options.maxResponseBytes);
      let parsed: ChatCompletionResponse;
      try {
        parsed = JSON.parse(text) as ChatCompletionResponse;
      } catch (error) {
        throw new AIError("AI_INVALID_OUTPUT", { cause: error });
      }
      const content = parsed.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "") {
        throw new AIError("AI_INVALID_OUTPUT", { cause: { reason: "empty_completion" } });
      }
      if (parsed.choices?.[0]?.finish_reason === "length") {
        throw new AIError("AI_INVALID_OUTPUT", { cause: { reason: "output_truncated" } });
      }
      return {
        text: content,
        tokens: {
          input: typeof parsed.usage?.prompt_tokens === "number" ? parsed.usage.prompt_tokens : null,
          output: typeof parsed.usage?.completion_tokens === "number" ? parsed.usage.completion_tokens : null,
        },
        model: typeof parsed.model === "string" ? parsed.model : options.model,
      };
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
    }
  }

  return {
    name: "openai",
    model: options.model,
    explainFinding: complete,
    explainTestFailure: complete,
    summarizeReport: complete,
    analyzeRuntimeError: complete,
    suggestTests: complete,
    answerReportQuestion: complete,
  };
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AIError("AI_INVALID_OUTPUT", { cause: { reason: "response_too_large" } });
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
