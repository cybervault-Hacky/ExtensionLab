import { describe, expect, it } from "vitest";
import { evaluateAssertion } from "@/lib/testing/assertions";
import { validateSelector } from "@/lib/testing/selectors";
import { computeTestScore } from "@/lib/testing/scoring";
import { generateDiagnostics } from "@/lib/testing/diagnostics";
import { discoverTests, getBuiltInTestCases } from "@/lib/testing/registry";
import { TestRunManager } from "@/lib/testing/test-runner";
import type { AssertionContext, TestResult } from "@/lib/testing/types";
import type { SandboxManager } from "@/lib/runtime/sandbox-manager";
import type { CreateSandboxResponse, NetworkEntry, RuntimeEvent, SandboxInfo } from "@/types/runtime";
import type { TestAction } from "@/lib/testing/types";
import type { ExtensionAnalysis } from "@/types/extension";

describe("selector validation", () => {
  it("accepts safe selectors", () => {
    expect(validateSelector("#status").ok).toBe(true);
    expect(validateSelector(".card").ok).toBe(true);
    expect(validateSelector("button").ok).toBe(true);
    expect(validateSelector('[data-testid="login"]').ok).toBe(true);
  });

  it("rejects unsafe selectors", () => {
    expect(validateSelector("").ok).toBe(false);
    expect(validateSelector("script").ok).toBe(true); // tag selectors are fine
    expect(validateSelector("body onload=alert(1)").ok).toBe(false);
    expect(validateSelector("a".repeat(250)).ok).toBe(false);
  });
});

describe("assertion engine", () => {
  const context: AssertionContext = {
    url: "https://example.com/path?token=1",
    consoleEvents: [
      { id: "1", timestamp: 1, type: "console", level: "log", source: "content.js", message: "content script loaded" },
      { id: "2", timestamp: 2, type: "error", level: "error", source: "page", message: "boom" },
    ],
    networkEntries: [
      { id: "n1", timestamp: 1, method: "GET", url: "https://example.com/api", status: 200, resourceType: "xhr", duration: 1 },
    ],
    extensionLoaded: true,
    contentScriptDetected: true,
    serviceWorkerDetected: true,
    popupAvailable: false,
    currentElement: { exists: true, visible: true, text: "hello" },
    currentElementSelector: "#status",
    currentTextInspection: "hello",
  };

  it("evaluates basic assertions deterministically", () => {
    expect(evaluateAssertion({ type: "element_exists", selector: "#status" }, context).passed).toBe(true);
    expect(evaluateAssertion({ type: "element_visible", selector: "#status" }, context).passed).toBe(true);
    expect(evaluateAssertion({ type: "url_contains", value: "example.com" }, context).passed).toBe(true);
    expect(evaluateAssertion({ type: "console_contains", value: "content script" }, context).passed).toBe(true);
    expect(evaluateAssertion({ type: "network_status_equals", expectedStatus: 200 }, context).passed).toBe(true);
    expect(evaluateAssertion({ type: "extension_loaded" }, context).passed).toBe(true);
  });

  it("fails assertions that did not actually pass", () => {
    expect(evaluateAssertion({ type: "element_exists", selector: "#missing" }, context).passed).toBe(false);
    expect(evaluateAssertion({ type: "network_status_equals", expectedStatus: 500 }, context).passed).toBe(false);
    expect(evaluateAssertion({ type: "runtime_error_none" }, context).passed).toBe(false);
  });
});

describe("test registry", () => {
  it("exposes a deterministic built-in registry", () => {
    const tests = getBuiltInTestCases();
    expect(tests.length).toBeGreaterThanOrEqual(6);
    expect(tests.some((test) => test.id === "extension-loads")).toBe(true);
  });

  it("discovers applicable tests from static analysis", () => {
    const analysis = makeAnalysis({
      manifestVersion: "v3",
      action: true,
      contentScripts: true,
      background: true,
      broadHost: true,
    });
    const { tests, context } = discoverTests(analysis);
    expect(context.hasPopup).toBe(true);
    expect(context.hasContentScripts).toBe(true);
    expect(context.hasServiceWorker).toBe(true);
    expect(tests.some((test) => test.id === "popup")).toBe(true);
    expect(tests.some((test) => test.id === "content-script")).toBe(true);
    expect(tests.some((test) => test.id === "permissions-broad")).toBe(true);
  });

  it("skips popup test when no popup is declared", () => {
    const mini = makeAnalysis({ manifestVersion: "v3", action: false, contentScripts: false, background: true, broadHost: false });
    const { tests } = discoverTests(mini);
    expect(tests.some((test) => test.id === "popup")).toBe(false);
  });
});

describe("scoring", () => {
  it("computes a deterministic score", () => {
    const results: TestResult[] = [
      result("a", "passed"),
      result("b", "passed"),
      result("c", "warning"),
      result("d", "failed"),
      result("e", "skipped"),
    ];
    const score = computeTestScore(results);
    expect(score.total).toBe(63);
    expect(score.passed).toBe(2);
    expect(score.skipped).toBe(1);
    expect(score.failed).toBe(1);
  });

  it("excludes skipped tests from the denominator", () => {
    const results: TestResult[] = [result("a", "passed"), result("b", "skipped")];
    const score = computeTestScore(results);
    expect(score.total).toBe(100);
  });
});

describe("diagnostics", () => {
  it("generates findings for failed tests with evidence", () => {
    const failed = result("x", "failed");
    failed.errors.push("Expected element #login was not found.");
    failed.evidence.push({ id: "e", timestamp: 1, kind: "screenshot", label: "Screenshot captured at failure." });
    const findings = generateDiagnostics([failed]);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((finding) => finding.severity === "high")).toBe(true);
    expect(findings.some((finding) => finding.relatedTestId === "x")).toBe(true);
  });
});

describe("test run lifecycle", () => {
  it("runs applicable tests and completes with real evidence", async () => {
    const sandbox = new FakeSandboxManager();
    const manager = new TestRunManager(sandbox as unknown as SandboxManager);
    const tests = getBuiltInTestCases().filter((test) =>
      ["extension-loads", "test-page-loads", "content-script", "service-worker", "console-runtime-errors", "network-requests"].includes(test.id),
    );
    const analysis = makeAnalysis({ manifestVersion: "v3", action: false, contentScripts: true, background: true, broadHost: false });
    const created = await manager.create({
      sourcePath: "/tmp/fake-source",
      analysis,
      tests,
      clientIp: "127.0.0.1",
    });
    await manager.start(created.runId, created.token);

    const info = await waitForFinished(manager, created.runId, created.token, 3000);
    expect(info.state).toBe("completed");
    expect(info.total).toBe(tests.length);
    expect(info.completed).toBe(tests.length);
    expect(sandbox.created).toBe(1);
    expect(sandbox.stopped).toBe(1);
    expect(info.score).toBeGreaterThan(0);
  });
});

class FakeSandboxManager {
  created = 0;
  stopped = 0;

  async create(): Promise<CreateSandboxResponse> {
    this.created += 1;
    return { sandboxId: "sandbox_fake", sessionToken: "tok", referenceId: "ref", status: "preparing" };
  }

  async start(): Promise<SandboxInfo> {
    return { sandboxId: "sandbox_fake", status: "running", browser: { product: "Chromium", version: "test", state: "running" }, createdAt: Date.now(), referenceId: "ref" };
  }

  async stop(): Promise<SandboxInfo> {
    this.stopped += 1;
    return { sandboxId: "sandbox_fake", status: "destroyed", browser: { product: "Chromium", version: "test", state: "stopped" }, createdAt: Date.now(), referenceId: "ref" };
  }

  async executeTestAction(_id: string, _token: string, action: TestAction): Promise<{ ok: boolean; data?: Record<string, unknown> }> {
    if (action.type === "open_popup") return { ok: false };
    if (action.type === "inspect_element") return { ok: true, data: { exists: true, visible: true, text: "status text" } };
    if (action.type === "inspect_text") return { ok: true, data: { text: "status text" } };
    return { ok: true };
  }

  getEvents(): RuntimeEvent[] {
    return [
      { id: "a", timestamp: Date.now(), type: "extension", level: "info", source: "extension", message: "Extension loaded. Service worker registered." },
      { id: "b", timestamp: Date.now(), type: "console", level: "log", source: "content.js", message: "content script loaded" },
      { id: "c", timestamp: Date.now(), type: "page", level: "info", source: "page", message: "Page loaded." },
    ];
  }

  getNetwork(): NetworkEntry[] {
    return [{ id: "n", timestamp: Date.now(), method: "GET", url: "http://127.0.0.1:8080/extensionlab-test", status: 200, resourceType: "document", duration: 1 }];
  }

  async screenshot(): Promise<Uint8Array | null> {
    return null;
  }
}

async function waitForFinished(manager: TestRunManager, runId: string, token: string, timeout: number): Promise<ReturnType<TestRunManager["getStatus"]>> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const info = manager.getStatus(runId, token);
    if (["completed", "failed", "timeout", "destroyed"].includes(info.state)) return info;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return manager.getStatus(runId, token);
}

function result(testId: string, status: TestResult["status"]): TestResult {
  return {
    testId,
    name: testId,
    description: testId,
    category: "page",
    status,
    duration: 1,
    startedAt: 1,
    finishedAt: 2,
    steps: [],
    assertions: [],
    evidence: [],
    errors: [],
    warnings: [],
  };
}

function makeAnalysis(overrides: {
  manifestVersion: "v3" | "v2";
  action: boolean;
  contentScripts: boolean;
  background: boolean;
  broadHost: boolean;
}): ExtensionAnalysis {
  return {
    createdAt: 1,
    sourceName: "test.zip",
    sourceSize: 100,
    rootPath: "",
    metadata: { name: "Test", version: "1.0.0", manifestVersionLabel: overrides.manifestVersion === "v3" ? "Manifest V3" : "Manifest V2", fileCount: 1, totalUncompressedSize: 100 },
    manifest: {
      name: "Test",
      version: "1.0.0",
      manifestVersion: overrides.manifestVersion,
      manifestVersionLabel: overrides.manifestVersion === "v3" ? "Manifest V3" : "Manifest V2",
      raw: {},
      presentFields: [],
      features: {
        action: overrides.action, browser_action: false, page_action: false, background: overrides.background, content_scripts: overrides.contentScripts, permissions: false, host_permissions: false, optional_permissions: false, icons: false, options_page: false, options_ui: false, web_accessible_resources: false, commands: false, content_security_policy: false,
      },
      detectedConfig: [],
    },
    permissions: { permissions: [], hostPermissions: [], optionalPermissions: [], categorized: [], broadPermissions: overrides.broadHost },
    files: { entries: [], tree: [], rootPath: "", rootLabel: "", totalUncompressedSize: 0, fileCount: 0 },
    issues: [],
    healthScore: { total: 90, categories: [], basis: "" },
  };
}
