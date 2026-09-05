import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createFakeAIProvider, type FakeAIProvider } from "@/lib/ai/providers/fake";
import { createOpenAIProvider } from "@/lib/ai/providers/openai";
import { runAIFeature } from "@/lib/ai/service";
import { loadReportSource, loadTestRunSource } from "@/lib/ai/sources";
import { acquireSlot, concurrencySnapshot, resetConcurrencyForTests } from "@/lib/ai/limits";
import { AIError } from "@/lib/ai/errors";
import { getQuotaUsage } from "@/lib/billing/entitlements";
import { countAIResultsForUser } from "@/lib/db/repositories/ai";
import { setAIProviderForTests } from "@/lib/ai/provider";
import { onMetric } from "@/lib/observability/logger";
import type { AIPrompt } from "@/lib/ai/types";
import { createFixture, makeUser, setupAIHarness, subscribe, type Harness } from "./helpers";

const prompt: AIPrompt = { feature: "summarize_report", system: "s", user: "u", schemaName: "summary", maxOutputTokens: 100 };

describe("OpenAI-compatible adapter", () => {
  function provider(fetchImpl: typeof fetch, maxResponseBytes = 64 * 1024) {
    return createOpenAIProvider({ apiKey: "test-key-not-real", model: "test-model", baseUrl: "https://ai.example.com/v1", maxResponseBytes, fetchImpl });
  }
  const options = () => ({ signal: new AbortController().signal, timeoutMs: 2000, requestId: "req_x" });

  it("sends the prompt as JSON chat completion with the key only in the Authorization header and returns text + tokens", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl: typeof fetch = async (url, init) => {
      seen = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ model: "test-model-2024", choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } }), { status: 200 });
    };
    const result = await provider(fetchImpl).summarizeReport(prompt, options());
    expect(result.text).toBe("{\"ok\":true}");
    expect(result.tokens).toEqual({ input: 12, output: 3 });
    expect(result.model).toBe("test-model-2024");
    expect(seen!.url).toBe("https://ai.example.com/v1/chat/completions");
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key-not-real");
    const body = JSON.parse(String(seen!.init.body)) as { messages: Array<{ role: string; content: string }>; response_format: { type: string } };
    expect(body.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(body.response_format.type).toBe("json_object");
    expect(String(seen!.init.body)).not.toContain("test-key-not-real");
  });

  it("maps provider failures onto stable codes without leaking detail", async () => {
    const status = (code: number) => provider(async () => new Response("{}", { status: code })).summarizeReport(prompt, options());
    await expect(status(429)).rejects.toMatchObject({ code: "AI_RATE_LIMITED" });
    await expect(status(504)).rejects.toMatchObject({ code: "AI_TIMEOUT" });
    await expect(status(401)).rejects.toMatchObject({ code: "AI_PROVIDER_ERROR" });
    await expect(status(500)).rejects.toMatchObject({ code: "AI_PROVIDER_ERROR" });
    await expect(provider(async () => { throw new Error("ECONNRESET"); }).summarizeReport(prompt, options())).rejects.toMatchObject({ code: "AI_PROVIDER_ERROR" });
  });

  it("times out slow providers and rejects empty, malformed, truncated or oversized responses", async () => {
    const slow: typeof fetch = (_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    await expect(provider(slow).summarizeReport(prompt, { ...options(), timeoutMs: 30 })).rejects.toMatchObject({ code: "AI_TIMEOUT" });
    await expect(provider(async () => new Response("not json", { status: 200 })).summarizeReport(prompt, options())).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
    await expect(provider(async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 })).summarizeReport(prompt, options())).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
    await expect(provider(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{" }, finish_reason: "length" }] }), { status: 200 })).summarizeReport(prompt, options())).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
    const huge = JSON.stringify({ choices: [{ message: { content: "x".repeat(10_000) } }] });
    await expect(provider(async () => new Response(huge, { status: 200 }), 1024).summarizeReport(prompt, options())).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
  });
});

describe("FakeAIProvider and the service pipeline", () => {
  let harness: Harness & { ai: FakeAIProvider };
  let fixture: ReturnType<typeof createFixture>;
  const metrics: Array<{ name: string; tags: Record<string, string> }> = [];
  let unsubscribe: () => void;

  beforeAll(() => {
    harness = setupAIHarness({ AI_TIMEOUT_MS: "1000" });
    unsubscribe = onMetric((name, _value, tags) => metrics.push({ name, tags }));
    const user = makeUser();
    subscribe(user.id, "pro");
    fixture = createFixture(user.id);
  });
  afterEach(() => {
    harness.ai.fake.reset();
    resetConcurrencyForTests();
  });
  afterAll(() => {
    unsubscribe();
    harness.teardown();
  });

  const report = () => loadReportSource(fixture.userId, fixture.reportId);
  const used = () => getQuotaUsage(fixture.userId, "ai_request").used;

  it("returns validated, evidence-linked output for every feature and charges exactly one AI request each", async () => {
    const before = used();
    const summary = await runAIFeature({ requestId: "r1", userId: fixture.userId, feature: "summarize_report", source: report() });
    expect(summary.result.kind).toBe("summary");
    expect(summary.meta.provider).toBe("fake");
    expect(summary.meta.disclaimer).toMatch(/Verify recommendations/);
    const explanation = await runAIFeature({ requestId: "r2", userId: fixture.userId, feature: "explain_finding", source: report(), focus: { findingId: "broad-host-access" }, targetId: "broad-host-access" });
    expect(explanation.result.kind).toBe("explanation");
    const evidence = (explanation.result as { evidence: Array<{ kind: string; id: string }> }).evidence;
    expect(evidence).toEqual(expect.arrayContaining([{ kind: "finding", id: "broad-host-access", label: "Broad host access" }]));
    const failure = await runAIFeature({ requestId: "r3", userId: fixture.userId, feature: "explain_test_failure", source: await loadTestRunSource(fixture.userId, fixture.runId, true), focus: { testId: "content-script-detected" }, targetId: "content-script-detected" });
    expect((failure.result as { evidence: Array<{ id: string }> }).evidence.some((ref) => ref.id === "content-script-detected")).toBe(true);
    const runtime = await runAIFeature({ requestId: "r4", userId: fixture.userId, feature: "analyze_runtime_error", source: await loadTestRunSource(fixture.userId, fixture.runId, true) });
    expect(runtime.result.kind).toBe("explanation");
    expect(["low", "medium", "high"]).toContain(runtime.result.confidence);
    const suggestions = await runAIFeature({ requestId: "r5", userId: fixture.userId, feature: "suggest_tests", source: report() });
    expect(suggestions.result.kind).toBe("test_suggestions");
    expect((suggestions.result as { tests: unknown[] }).tests.length).toBeGreaterThan(0);
    const answer = await runAIFeature({ requestId: "r6", userId: fixture.userId, feature: "answer_report_question", source: report(), focus: { question: "Which finding should I fix first?" }, targetId: "q1" });
    expect(answer.result.kind).toBe("answer");
    expect((answer.result as { outOfScope: boolean }).outOfScope).toBe(false);
    expect(used() - before).toBe(6);
    expect(harness.ai.fake.calls()).toBe(6);
  });

  it("serves identical evidence from the stored result without a provider call or a quota charge", async () => {
    const before = used();
    const first = await runAIFeature({ requestId: "c1", userId: fixture.userId, feature: "summarize_report", source: report(), targetId: "cache" });
    const second = await runAIFeature({ requestId: "c2", userId: fixture.userId, feature: "summarize_report", source: report(), targetId: "cache" });
    expect(first.meta.cached).toBe(false);
    expect(second.meta.cached).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(used() - before).toBe(1);
    expect(countAIResultsForUser(fixture.userId)).toBeGreaterThan(0);
  });

  it.each([
    ["timeout", "AI_TIMEOUT"],
    ["provider_error", "AI_PROVIDER_ERROR"],
    ["rate_limited", "AI_RATE_LIMITED"],
    ["malformed_json", "AI_INVALID_OUTPUT"],
    ["empty", "AI_INVALID_OUTPUT"],
    ["oversized", "AI_INVALID_OUTPUT"],
    ["wrong_schema", "AI_INVALID_OUTPUT"],
  ] as const)("scenario %s surfaces %s, releases the reservation and never charges quota", async (scenario, code) => {
    const before = used();
    harness.ai.fake.queue(scenario);
    await expect(runAIFeature({ requestId: `f_${scenario}`, userId: fixture.userId, feature: "summarize_report", source: report(), targetId: `fail-${scenario}` })).rejects.toMatchObject({ code });
    expect(used()).toBe(before);
    expect(getQuotaUsage(fixture.userId, "ai_request").reserved).toBe(0);
    expect(concurrencySnapshot().global).toBe(0);
  });

  it("unsafe generated tests are rejected individually while valid ones are kept", async () => {
    harness.ai.fake.queue("unsafe_tests");
    const response = await runAIFeature({ requestId: "u1", userId: fixture.userId, feature: "suggest_tests", source: report(), targetId: "unsafe" });
    const result = response.result as { tests: Array<{ id: string }>; rejected: Array<{ name: string; reason: string }> };
    expect(result.tests.map((t) => t.id)).toEqual(["ai-console-clean-after-load", "ai-status-element-visible"]);
    const reasons = result.rejected.map((r) => `${r.name}: ${r.reason}`).join("\n");
    expect(reasons).toMatch(/execute_script/);
    expect(reasons).toMatch(/Only https URLs/);
    expect(reasons).toMatch(/private, local, or internal|cannot be tested/);
    expect(reasons).toMatch(/at most 24 steps/);
    expect(reasons).toMatch(/executable or command-like/);
    expect(reasons).toMatch(/safe CSS selectors/);
  });

  it("emits aggregate metrics with feature/provider/result tags and no content", () => {
    const names = new Set(metrics.map((m) => m.name));
    expect(names).toEqual(expect.any(Set));
    expect([...names]).toEqual(expect.arrayContaining(["ai.request", "ai.success", "ai.duration_ms", "ai.timeout", "ai.provider_error", "ai.invalid_output", "ai.cache_hit"]));
    for (const metric of metrics) {
      expect(Object.keys(metric.tags).sort()).toEqual(["feature", "provider", "result"]);
    }
  });

  it("bounds in-flight provider calls globally and per user", () => {
    const a = acquireSlot("user-a", { global: 2, perUser: 1 });
    expect(() => acquireSlot("user-a", { global: 2, perUser: 1 })).toThrowError(AIError);
    const b = acquireSlot("user-b", { global: 2, perUser: 1 });
    expect(() => acquireSlot("user-c", { global: 2, perUser: 1 })).toThrowError(/busy/);
    a.release();
    a.release(); // idempotent
    const c = acquireSlot("user-c", { global: 2, perUser: 1 });
    b.release();
    c.release();
    expect(concurrencySnapshot()).toEqual({ global: 0, users: 0 });
  });

  it("answers AI_NOT_CONFIGURED when no provider is active and never falls back to the fake", async () => {
    setAIProviderForTests(null);
    process.env.AI_PROVIDER = "disabled";
    const { resetConfigCache } = await import("@/lib/config/env");
    resetConfigCache();
    try {
      await expect(runAIFeature({ requestId: "nc", userId: fixture.userId, feature: "summarize_report", source: report() })).rejects.toMatchObject({ code: "AI_NOT_CONFIGURED" });
      expect(harness.ai.fake.calls()).toBe(0);
    } finally {
      process.env.AI_PROVIDER = "fake";
      resetConfigCache();
      setAIProviderForTests(harness.ai);
    }
  });
});

describe("fake provider is deterministic", () => {
  it("produces identical output for identical prompts and honours queued scenarios in order", async () => {
    const fake = createFakeAIProvider();
    const p: AIPrompt = { feature: "summarize_report", system: "s", user: "<EXTENSIONLAB_DATA>\n{\"findings\":[],\"tests\":[]}\n</EXTENSIONLAB_DATA>", schemaName: "summary", maxOutputTokens: 10 };
    const opts = { signal: new AbortController().signal, timeoutMs: 100, requestId: "r" };
    const a = await fake.summarizeReport(p, opts);
    const b = await fake.summarizeReport(p, opts);
    expect(a.text).toBe(b.text);
    fake.fake.queue("provider_error", "malformed_json");
    await expect(fake.summarizeReport(p, opts)).rejects.toMatchObject({ code: "AI_PROVIDER_ERROR" });
    expect((await fake.summarizeReport(p, opts)).text).toBe("{ this is not json");
    expect(fake.fake.calls()).toBe(4);
  });
});
