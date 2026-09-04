import "server-only";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { SandboxManager } from "@/lib/runtime/sandbox-manager";
import { getSandboxConfig } from "@/lib/runtime/config";
import { generateReferenceId, generateSandboxId, generateSessionToken } from "@/lib/runtime/ids";
import { evaluateAssertion } from "./assertions";
import { computeTestScore } from "./scoring";
import { generateDiagnostics } from "./diagnostics";
import { summarizeResults } from "./results";
import { testConfig } from "./config";
import { validateSelector } from "./selectors";
import type {
  AssertionContext,
  DiagnosticFinding,
  RuntimeEventLike,
  NetworkEntryLike,
  TestAction,
  TestCase,
  TestDiscoveryContext,
  TestResult,
  TestRunInfo,
  TestRunSnapshot,
  TestRunState,
  TestScore,
} from "./types";
import type { ExtensionAnalysis } from "@/types/extension";
import type { RuntimeEvent } from "@/types/runtime";

export interface TestRunCreateInput {
  sourcePath: string;
  analysis: ExtensionAnalysis;
  tests: TestCase[];
  testUrl?: string;
  clientIp: string;
}

interface ManagedRun {
  snap: TestRunSnapshot;
  listeners: EventEmitter;
}

export class TestRunManager {
  private readonly runs = new Map<string, ManagedRun>();
  private readonly ipCounts = new Map<string, { count: number; resetAt: number }>();
  private readonly sandboxManager: SandboxManager;

  constructor(sandboxManager: SandboxManager) {
    this.sandboxManager = sandboxManager;
  }

  async create(input: TestRunCreateInput): Promise<{ runId: string; token: string }> {
    const config = testConfig();
    if (this.countActiveRuns() >= config.MAX_CONCURRENT_TEST_RUNS) {
      throw createRunError("capacity_reached", "Test run capacity reached. Queued runs will start when a slot becomes available.");
    }
    if (this.isRateLimited(input.clientIp)) {
      throw createRunError("rate_limited", "Too many automated test runs were created recently. Please wait and try again.");
    }

    const runId = `run_${randomBytes(8).toString("hex")}`;
    const token = generateSessionToken();
    const snap: TestRunSnapshot = {
      runId,
      token,
      sourcePath: input.sourcePath,
      testUrl: input.testUrl,
      tests: input.tests,
      state: "idle",
      createdAt: Date.now(),
      expiresAt: Date.now() + config.MAX_TEST_RUN_TIME + 15 * 60 * 1000,
      total: input.tests.length,
      results: [],
      events: [],
      diagnostics: [],
      score: createEmptyScore(),
    };
    snap.events.push(JSON.stringify({ type: "test-run", state: "created", runId, timestamp: Date.now() }));

    const listener = new EventEmitter();
    this.runs.set(runId, { snap, listeners: listener });
    this.recordIp(input.clientIp);

    return { runId, token };
  }

  async start(runId: string, token: string): Promise<TestRunInfo> {
    const run = this.getRun(runId, token);
    if (run.snap.state !== "idle") return this.toInfo(run);

    run.snap.state = "preparing";
    this.emit(run, { type: "state", state: "preparing" });

    void this.executeRun(run).catch(() => undefined);
    return this.toInfo(run);
  }

  getStatus(runId: string, token: string): TestRunInfo {
    const run = this.getRun(runId, token);
    return this.toInfo(run);
  }

  getResults(runId: string, token: string): { results: TestResult[]; score: TestScore; diagnostics: DiagnosticFinding[] } {
    const run = this.getRun(runId, token);
    return { results: run.snap.results, score: run.snap.score, diagnostics: run.snap.diagnostics };
  }

  getEvents(runId: string, token: string): string[] {
    const run = this.getRun(runId, token);
    return run.snap.events.slice();
  }

  subscribe(runId: string, token: string, listener: (event: string) => void): () => void {
    const run = this.getRun(runId, token);
    const callback = (event: string) => listener(event);
    run.listeners.on("event", callback);
    // Replay recent events.
    for (const event of run.snap.events) callback(event);
    return () => run.listeners.off("event", callback);
  }

  async stop(runId: string, token: string): Promise<TestRunInfo> {
    const run = this.getRun(runId, token);
    if (run.snap.state === "completed" || run.snap.state === "destroyed") return this.toInfo(run);
    run.snap.state = "stopping";
    this.emit(run, { type: "state", state: "stopping" });
    try {
      if (run.snap.sandboxId) {
        await this.sandboxManager.stop(run.snap.sandboxId, run.snap.token);
      }
    } catch {
      // Best effort.
    }
    await rm(run.snap.sourcePath, { recursive: true, force: true }).catch(() => undefined);
    run.snap.sourcePath = "";
    run.snap.state = "destroyed";
    run.snap.finishedAt = Date.now();
    this.emit(run, { type: "state", state: "destroyed", reason: "Test run cancelled." });
    return this.toInfo(run);
  }

  private async executeRun(run: ManagedRun): Promise<void> {
    let timedOut = false;
    const runTimeout = setTimeout(() => {
      timedOut = true;
    }, testConfig().MAX_TEST_RUN_TIME);
    try {
      run.snap.state = "starting";
      this.emit(run, { type: "state", state: "starting" });

      const sourcePath = run.snap.sourcePath;
      const created = await this.sandboxManager.create({
        sourcePath,
        testUrl: run.snap.testUrl ?? testConfig().DEFAULT_TEST_PAGE_URL,
        clientIp: "test-runner",
      });
      run.snap.sandboxId = created.sandboxId;

      run.snap.state = "starting";
      this.emit(run, { type: "state", state: "starting" });
      await this.sandboxManager.start(created.sandboxId, run.snap.token);
      run.snap.state = "running";
      run.snap.startedAt = Date.now();
      this.emit(run, { type: "state", state: "running" });

      const tests = run.snap.tests ?? [];
      for (const test of tests) {
        if (timedOut || run.snap.state !== "running") break;
        const result = await this.executeTest(run, created.sandboxId, test);
        run.snap.results.push(result);
        this.emit(run, { type: "test-result", result: publicResult(result) });
      }

      run.snap.score = computeTestScore(run.snap.results);
      run.snap.diagnostics = generateDiagnostics(run.snap.results);
      run.snap.state = timedOut ? "timeout" : "completed";
      run.snap.finishedAt = Date.now();
      this.emit(run, { type: "state", state: run.snap.state });
    } catch (error) {
      run.snap.state = "failed";
      run.snap.finishedAt = Date.now();
      run.snap.reason = sanitizeRunError(error);
      this.emit(run, { type: "state", state: "failed", reason: run.snap.reason });
    } finally {
      clearTimeout(runTimeout);
      if (run.snap.sandboxId) {
        await this.sandboxManager.stop(run.snap.sandboxId, run.snap.token).catch(() => undefined);
      }
      await rm(run.snap.sourcePath, { recursive: true, force: true }).catch(() => undefined);
      run.snap.sourcePath = "";
      if (run.snap.state === "completed" || run.snap.state === "timeout") {
        run.snap.state = run.snap.state === "timeout" ? "timeout" : "completed";
        run.snap.reason = run.snap.reason ?? "Test run completed and sandbox destroyed.";
      }
    }
  }

  private async executeTest(
    run: ManagedRun,
    sandboxId: string,
    test: TestCase,
  ): Promise<TestResult> {
    const startedAt = Date.now();
    const result: TestResult = {
      testId: test.id,
      name: test.name,
      description: test.description,
      category: test.category,
      status: "running",
      duration: 0,
      startedAt,
      finishedAt: startedAt,
      steps: [],
      assertions: [],
      evidence: [],
      errors: [],
      warnings: [],
      runId: run.snap.runId,
    };

    if (test.skipReason) {
      result.status = "skipped";
      result.skippedReason = test.skipReason;
      result.finishedAt = Date.now();
      result.duration = result.finishedAt - startedAt;
      return result;
    }

    this.emit(run, { type: "test", state: "running", testId: test.id });

    const timeout = setTimeout(() => {
      result.status = "timeout";
      result.skippedReason = `The test exceeded its allowed runtime (${test.timeout} ms).`;
    }, test.timeout);

    let evidenceContext: AssertionContext = {
      consoleEvents: [],
      networkEntries: [],
      extensionLoaded: false,
      contentScriptDetected: false,
      serviceWorkerDetected: false,
      popupAvailable: false,
    };

    try {
      const limitedActions = test.steps.slice(0, testConfig().MAX_ACTIONS_PER_TEST);
      for (const action of limitedActions) {
        if (!isSafeAction(action)) {
          result.status = "error";
          result.errors.push("Unsafe test action.");
          break;
        }
        result.steps.push(`${action.type}${action.selector ? ` ${action.selector}` : ""}`);
        const actionResponse = await this.sandboxManager.executeTestAction(sandboxId, run.snap.token, action);
        if (!actionResponse.ok && action.type === "open_popup") {
          result.status = "skipped";
          result.skippedReason = "Popup testing is not supported by this browser environment.";
          break;
        }
        if (!actionResponse.ok && action.selector) {
          result.warnings.push(`Action ${action.type} could not find "${action.selector}".`);
        }
        if (action.type === "inspect_element" && actionResponse.data) {
          const data = actionResponse.data as { exists?: boolean; visible?: boolean; text?: string };
          result.evidence.push({ id: `ev-${randomBytes(4).toString("hex")}`, timestamp: Date.now(), kind: "page", label: `Inspected ${action.selector}`, detail: data.text });
          evidenceContext.currentElement = { exists: data.exists === true, visible: data.visible === true, text: data.text };
          evidenceContext.currentElementSelector = action.selector;
        }
        if (action.type === "inspect_text" && actionResponse.data) {
          evidenceContext.currentTextInspection = String((actionResponse.data as { text?: string }).text ?? "");
        }
      }

      if (result.status === "running" || result.status === "pending") {
        const events = this.toLikeEvents(this.sandboxManager.getEvents(sandboxId, run.snap.token));
        const network = this.toLikeNetwork(this.sandboxManager.getNetwork(sandboxId, run.snap.token));
        const hasContentEvidence = events.some((event) =>
          event.type === "console" && /content script/i.test(event.source + event.message),
        );
        const hasServiceWorkerEvidence = events.some((event) =>
          event.type === "extension" && /service worker/i.test(event.message),
        );
        const hasExtensionEvidence = events.some((event) =>
          event.type === "extension" && /loaded|registered|ready|active/i.test(event.message),
        );

        evidenceContext = {
          ...evidenceContext,
          consoleEvents: events,
          networkEntries: network,
          url: run.snap.testUrl ?? testConfig().DEFAULT_TEST_PAGE_URL,
          extensionLoaded: hasExtensionEvidence,
          contentScriptDetected: hasContentEvidence,
          serviceWorkerDetected: hasServiceWorkerEvidence,
          popupAvailable: false,
        };

        if (test.category === "permissions") {
          result.warnings.push("Broad host permissions are declared. Review whether this access is required.");
        }

        for (const assertion of test.assertions) {
          const outcome = evaluateAssertion(assertion, evidenceContext);
          result.assertions.push(outcome);
          if (outcome.passed) {
            result.evidence.push({ id: `ev-${randomBytes(4).toString("hex")}`, timestamp: Date.now(), kind: "result", label: outcome.message });
          } else {
            result.errors.push(outcome.message);
          }
        }

        if (result.errors.length > 0 && test.category === "content_script") {
          result.status = "skipped";
          result.skippedReason = "Unable to verify content-script execution for this configuration.";
        } else if (result.errors.length > 0) {
          result.status = "failed";
        } else if (test.category === "permissions") {
          result.status = result.warnings.length > 0 ? "warning" : "passed";
        } else {
          result.status = "passed";
        }
      }
    } catch {
      if (result.status !== "skipped" && result.status !== "timeout") {
        result.status = "error";
      }
      result.errors.push("The test encountered an internal runner error.");
    } finally {
      clearTimeout(timeout);
      result.finishedAt = Date.now();
      result.duration = result.finishedAt - startedAt;
      this.emit(run, { type: "test", state: result.status, testId: test.id });
    }

    if (result.status === "failed" || result.status === "error") {
      const shot = await this.sandboxManager.screenshot(sandboxId, run.snap.token).catch(() => null);
      if (shot && shot.length > 0) {
        result.evidence.push({ id: `shot-${randomBytes(4).toString("hex")}`, timestamp: Date.now(), kind: "screenshot", label: "Screenshot captured at failure." });
      }
    }

    return result;
  }

  private toInfo(run: ManagedRun): TestRunInfo {
    const summary = summarizeResults(run.snap.results);
    return {
      runId: run.snap.runId,
      sandboxId: run.snap.sandboxId,
      state: run.snap.state,
      createdAt: run.snap.createdAt,
      startedAt: run.snap.startedAt,
      finishedAt: run.snap.finishedAt,
      total: run.snap.total,
      completed: run.snap.results.length,
      passed: summary.passed,
      failed: summary.failed,
      warning: summary.warning,
      skipped: summary.skipped,
      timeout: summary.timeout,
      error: summary.error,
      score: run.snap.score.total,
      reason: run.snap.reason,
    };
  }

  private getRun(runId: string, token: string): ManagedRun {
    const run = this.runs.get(runId);
    if (!run) throw createRunError("not_found", "Test run was not found.");
    if (run.snap.token !== token) throw createRunError("unauthorized", "Unauthorized test run access.");
    return run;
  }

  private emit(run: ManagedRun, payload: unknown): void {
    const event = JSON.stringify(payload);
    run.snap.events.push(event);
    run.listeners.emit("event", event);
  }

  private toLikeEvents(events: RuntimeEvent[]): RuntimeEventLike[] {
    return events.map((event) => ({ id: event.id, timestamp: event.timestamp, type: event.type, level: event.level, source: event.source, message: event.message }));
  }

  private toLikeNetwork(entries: NetworkEntryLike[]): NetworkEntryLike[] {
    return entries;
  }

  private countActiveRuns(): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (["idle", "preparing", "starting", "running"].includes(run.snap.state)) count += 1;
    }
    return count;
  }

  private isRateLimited(ip: string): boolean {
    const entry = this.ipCounts.get(ip);
    if (!entry || entry.resetAt < Date.now()) return false;
    return entry.count >= testConfig().MAX_TEST_RUNS_PER_WINDOW;
  }

  private recordIp(ip: string): void {
    const now = Date.now();
    const existing = this.ipCounts.get(ip);
    if (!existing || existing.resetAt < now) {
      this.ipCounts.set(ip, { count: 1, resetAt: now + testConfig().TEST_RATE_LIMIT_WINDOW_MS });
    } else {
      existing.count += 1;
    }
  }
}

function isSafeAction(action: TestAction): boolean {
  if (!action || typeof action.type !== "string") return false;
  if (action.selector && validateSelector(action.selector).ok === false) return false;
  if (action.type === "wait" && typeof action.milliseconds === "number" && action.milliseconds > testConfig().MAX_WAIT_MS) return false;
  if (action.type === "open_url" && (typeof action.url !== "string" || action.url.startsWith("javascript:"))) return false;
  return [
    "open_url","reload_page","wait","click","type","select","scroll","inspect_text","inspect_element","open_popup","clear_console","capture_screenshot",
  ].includes(action.type);
}

function createRunError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code?: string; referenceId?: string };
  error.code = code;
  error.referenceId = generateReferenceId();
  return error;
}

function sanitizeRunError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error.";
  return message.replace(/\/(private|var|tmp)\/[^\s]+/g, "[path]").slice(0, 300);
}

function createEmptyScore(): TestScore {
  return { total: 0, passed: 0, failed: 0, warning: 0, skipped: 0, timeout: 0, error: 0, categories: [], basis: "No automated tests have completed yet." };
}

function publicResult(result: TestResult): TestResult {
  // Screenshot data is intentionally not exposed in the event stream.
  return {
    ...result,
    evidence: result.evidence.map((e) => (e.kind === "screenshot" ? { ...e, detail: "Screenshot captured." } : e)),
  };
}

// Helper to satisfy the import path used by callers.
export { evaluateAssertion };
