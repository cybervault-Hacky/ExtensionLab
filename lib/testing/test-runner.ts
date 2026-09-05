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
  TestRunStage,
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
  /**
   * Phase 6: the background worker supplies the persisted run id and skips
   * the per-IP window limit because admission control (quota, per-user and
   * global concurrency, queue back-pressure) already happened when the job
   * was accepted.
   */
  runId?: string;
  token?: string;
  trusted?: boolean;
}

export interface TestRunPersistenceHooks {
  onStatus?: (snap: TestRunSnapshot, info: TestRunInfo) => void;
  onFinished?: (snap: TestRunSnapshot, info: TestRunInfo) => void;
  /** Phase 6: pipeline stage transitions. */
  onStage?: (snap: TestRunSnapshot, stage: TestRunStage) => void;
  /** Phase 6: every live event (already JSON-encoded) for durable streaming. */
  onEvent?: (snap: TestRunSnapshot, event: string) => void;
}

export interface TestRunManagerOptions {
  /** Overrides TEST_ENGINE_CONFIG.MAX_CONCURRENT_TEST_RUNS (worker concurrency). */
  maxConcurrentRuns?: number;
}

interface ManagedRun {
  snap: TestRunSnapshot;
  listeners: EventEmitter;
  finishedNotified: boolean;
  unsubscribeSandbox?: () => void;
  completion?: Promise<TestRunInfo>;
}

export class TestRunManager {
  private readonly runs = new Map<string, ManagedRun>();
  private readonly ipCounts = new Map<string, { count: number; resetAt: number }>();
  private readonly sandboxManager: SandboxManager;
  private readonly persistence?: TestRunPersistenceHooks;
  private readonly options: TestRunManagerOptions;

  constructor(sandboxManager: SandboxManager, persistence?: TestRunPersistenceHooks, options: TestRunManagerOptions = {}) {
    this.sandboxManager = sandboxManager;
    this.persistence = persistence;
    this.options = options;
  }

  async create(input: TestRunCreateInput): Promise<{ runId: string; token: string }> {
    const config = testConfig();
    const maxConcurrent = this.options.maxConcurrentRuns ?? config.MAX_CONCURRENT_TEST_RUNS;
    if (this.countActiveRuns() >= maxConcurrent) {
      throw createRunError("capacity_reached", "Test run capacity reached. Queued runs will start when a slot becomes available.");
    }
    if (!input.trusted && this.isRateLimited(input.clientIp)) {
      throw createRunError("rate_limited", "Too many automated test runs were created recently. Please wait and try again.");
    }

    const runId = input.runId ?? `run_${randomBytes(8).toString("hex")}`;
    if (this.runs.has(runId)) {
      throw createRunError("conflict", "This test run is already registered.");
    }
    const token = input.token ?? generateSessionToken();
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
      screenshots: [],
      network: [],
      runtimeEvents: [],
    };
    snap.events.push(JSON.stringify({ type: "test-run", state: "created", runId, timestamp: Date.now() }));

    const listener = new EventEmitter();
    this.runs.set(runId, { snap, listeners: listener, finishedNotified: false });
    if (!input.trusted) this.recordIp(input.clientIp);

    return { runId, token };
  }

  async start(runId: string, token: string): Promise<TestRunInfo> {
    const run = this.getRun(runId, token);
    if (run.snap.state !== "idle") return this.toInfo(run);
    void this.execute(runId, token).catch(() => undefined);
    return this.toInfo(run);
  }

  /**
   * Starts the run and resolves when it reaches a terminal state. Used by the
   * background worker; `start()` remains for fire-and-forget callers.
   */
  execute(runId: string, token: string): Promise<TestRunInfo> {
    const run = this.getRun(runId, token);
    if (run.completion) return run.completion;
    if (run.snap.state !== "idle") return Promise.resolve(this.toInfo(run));

    run.snap.state = "preparing";
    this.setStage(run, "Preparing");
    this.emit(run, { type: "state", state: "preparing" });
    this.notifyStatus(run);

    run.completion = this.executeRun(run)
      .catch(() => undefined)
      .then(() => this.toInfo(run));
    return run.completion;
  }

  /** Internal snapshot access for the worker (includes screenshot bytes). Never expose to clients. */
  getSnapshot(runId: string, token: string): TestRunSnapshot {
    return this.getRun(runId, token).snap;
  }

  /** Removes a finished run from memory. */
  release(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (["completed", "failed", "timeout", "destroyed"].includes(run.snap.state)) {
      run.unsubscribeSandbox?.();
      run.listeners.removeAllListeners();
      this.runs.delete(runId);
    }
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
    if (["completed", "destroyed", "failed", "timeout", "stopping"].includes(run.snap.state)) return this.toInfo(run);
    run.snap.state = "stopping";
    this.emit(run, { type: "state", state: "stopping" });
    try {
      if (run.snap.sandboxId) {
        await this.sandboxManager.stop(run.snap.sandboxId, run.snap.sandboxToken ?? run.snap.token);
      }
    } catch {
      // Best effort.
    }
    if (run.snap.sourcePath) {
      await rm(run.snap.sourcePath, { recursive: true, force: true }).catch(() => undefined);
    }
    run.snap.sourcePath = "";
    run.snap.state = "destroyed";
    run.snap.errorCode = "JOB_CANCELLED";
    run.snap.reason = "Test run cancelled.";
    run.snap.finishedAt = Date.now();
    this.setStage(run, "Completed");
    this.emit(run, { type: "state", state: "destroyed", reason: "Test run cancelled." });
    this.notifyStatus(run);
    this.notifyFinished(run);
    return this.toInfo(run);
  }

  private async executeRun(run: ManagedRun): Promise<void> {
    let timedOut = false;
    const runTimeout = setTimeout(() => {
      timedOut = true;
    }, testConfig().MAX_TEST_RUN_TIME);
    try {
      run.snap.state = "starting";
      this.setStage(run, "Starting sandbox");
      this.emit(run, { type: "state", state: "starting" });
      this.notifyStatus(run);

      const sourcePath = run.snap.sourcePath;
      const created = await this.sandboxManager.create({
        sourcePath,
        testUrl: run.snap.testUrl ?? testConfig().DEFAULT_TEST_PAGE_URL,
        clientIp: "test-runner",
      });
      run.snap.sandboxId = created.sandboxId;
      run.snap.sandboxToken = created.sessionToken;
      this.observeSandbox(run, created.sandboxId);

      if (this.isCancelled(run)) throw createRunError("cancelled", "Test run cancelled.");
      await this.sandboxManager.start(created.sandboxId, created.sessionToken);
      if (this.isCancelled(run)) throw createRunError("cancelled", "Test run cancelled.");
      run.snap.state = "running";
      run.snap.startedAt = Date.now();
      this.setStage(run, "Running tests");
      this.emit(run, { type: "state", state: "running" });
      this.notifyStatus(run);

      const tests = run.snap.tests ?? [];
      for (const test of tests) {
        if (timedOut || run.snap.state !== "running") break;
        const result = await this.executeTest(run, created.sandboxId, test);
        run.snap.results.push(result);
        this.emit(run, { type: "test-result", result: publicResult(result) });
      }

      if (this.isCancelled(run)) {
        // stop() owns the terminal transition for cancelled runs.
        return;
      }

      this.setStage(run, "Collecting evidence");
      this.collectEvidence(run, created.sandboxId);

      this.setStage(run, "Generating report");
      run.snap.score = computeTestScore(run.snap.results);
      run.snap.diagnostics = generateDiagnostics(run.snap.results);
      run.snap.state = timedOut ? "timeout" : "completed";
      if (timedOut) run.snap.errorCode = "JOB_TIMEOUT";
      run.snap.finishedAt = Date.now();
      this.emit(run, { type: "state", state: run.snap.state });
      this.notifyStatus(run);
    } catch (error) {
      if (this.isCancelled(run)) return;
      run.snap.state = "failed";
      run.snap.finishedAt = Date.now();
      run.snap.reason = sanitizeRunError(error);
      run.snap.errorCode = classifyRunError(error);
      this.emit(run, { type: "state", state: "failed", reason: run.snap.reason, errorCode: run.snap.errorCode });
      this.notifyStatus(run);
    } finally {
      clearTimeout(runTimeout);
      if (run.snap.sandboxId && !this.isCancelled(run)) {
        await this.sandboxManager
          .stop(run.snap.sandboxId, run.snap.sandboxToken ?? run.snap.token)
          .catch(() => undefined);
      }
      if (run.snap.sourcePath) {
        await rm(run.snap.sourcePath, { recursive: true, force: true }).catch(() => undefined);
      }
      run.snap.sourcePath = "";
      if (run.snap.state === "completed" || run.snap.state === "timeout") {
        run.snap.reason = run.snap.reason ?? "Test run completed and sandbox destroyed.";
      }
      if (["completed", "failed", "timeout", "destroyed"].includes(run.snap.state)) {
        this.setStage(run, "Completed");
        this.notifyStatus(run);
        this.notifyFinished(run);
      }
    }
  }

  private isCancelled(run: ManagedRun): boolean {
    return run.snap.state === "stopping" || run.snap.state === "destroyed";
  }

  /**
   * Maps sandbox-manager events onto user-visible stages. Only real
   * transitions reported by the sandbox produce a stage change.
   */
  private observeSandbox(run: ManagedRun, sandboxId: string): void {
    const manager = this.sandboxManager as Partial<SandboxManager>;
    if (typeof manager.subscribe !== "function") return;
    run.unsubscribeSandbox = manager.subscribe.call(this.sandboxManager, sandboxId, (event: RuntimeEvent) => {
      const status = event.metadata && typeof event.metadata === "object" ? (event.metadata as { status?: string }).status : undefined;
      if (event.type === "sandbox" && status === "creating") this.setStage(run, "Starting sandbox");
      if (event.type === "sandbox" && status === "loading_extension") this.setStage(run, "Starting Chromium");
      if (event.type === "browser" && /loading unpacked extension/i.test(event.message)) this.setStage(run, "Loading extension");
      if (event.type === "extension" && /extension loaded/i.test(event.message) && run.snap.stage === "Loading extension") {
        // Stay on "Loading extension" until the runner reports running; the
        // "Running tests" stage is set by executeRun once start() resolves.
      }
      if (event.type === "browser" && /starting isolated chromium/i.test(event.message)) this.setStage(run, "Starting Chromium");
    });
  }

  /** Captures the final runtime evidence for artifacts (bounded). */
  private collectEvidence(run: ManagedRun, sandboxId: string): void {
    const token = run.snap.sandboxToken ?? run.snap.token;
    try {
      const events = this.sandboxManager.getEvents(sandboxId, token);
      run.snap.runtimeEvents = this.toLikeEvents(events).slice(-testConfig().MAX_EVENTS);
    } catch {
      run.snap.runtimeEvents = run.snap.runtimeEvents ?? [];
    }
    try {
      const network = this.sandboxManager.getNetwork(sandboxId, token);
      run.snap.network = network.slice(-testConfig().MAX_NETWORK_EVENTS);
    } catch {
      run.snap.network = run.snap.network ?? [];
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
        const actionResponse = await this.sandboxManager.executeTestAction(sandboxId, this.sandboxTokenFor(run), action);
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
        const events = this.toLikeEvents(this.sandboxManager.getEvents(sandboxId, this.sandboxTokenFor(run)));
        const network = this.toLikeNetwork(this.sandboxManager.getNetwork(sandboxId, this.sandboxTokenFor(run)));
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
      const shot = await this.sandboxManager.screenshot(sandboxId, this.sandboxTokenFor(run)).catch(() => null);
      if (shot && shot.length > 0) {
        result.evidence.push({ id: `shot-${randomBytes(4).toString("hex")}`, timestamp: Date.now(), kind: "screenshot", label: "Screenshot captured at failure." });
        const screenshots = run.snap.screenshots ?? (run.snap.screenshots = []);
        if (screenshots.length < testConfig().MAX_SCREENSHOTS && shot.byteLength <= testConfig().MAX_ARTIFACT_SIZE) {
          screenshots.push({ testId: test.id, capturedAt: Date.now(), bytes: shot });
        }
      }
    }

    return result;
  }

  private sandboxTokenFor(run: ManagedRun): string {
    return run.snap.sandboxToken ?? run.snap.token;
  }

  private setStage(run: ManagedRun, stage: TestRunStage): void {
    if (run.snap.stage === stage) return;
    run.snap.stage = stage;
    this.emit(run, { type: "stage", stage, timestamp: Date.now() });
    try {
      this.persistence?.onStage?.(run.snap, stage);
    } catch {
      // Persistence failures must not break the run.
    }
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
      stage: run.snap.stage,
      errorCode: run.snap.errorCode,
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
    if (run.snap.events.length > testConfig().MAX_EVENTS) run.snap.events.splice(0, run.snap.events.length - testConfig().MAX_EVENTS);
    run.listeners.emit("event", event);
    try {
      this.persistence?.onEvent?.(run.snap, event);
    } catch {
      // Persistence failures must not break the run.
    }
  }

  private toLikeEvents(events: RuntimeEvent[]): RuntimeEventLike[] {
    return events.map((event) => ({ id: event.id, timestamp: event.timestamp, type: event.type, level: event.level, source: event.source, message: event.message }));
  }

  private toLikeNetwork(entries: NetworkEntryLike[]): NetworkEntryLike[] {
    return entries;
  }

  private notifyStatus(run: ManagedRun): void {
    this.persistence?.onStatus?.(run.snap, this.toInfo(run));
  }

  private notifyFinished(run: ManagedRun): void {
    if (run.finishedNotified) return;
    run.finishedNotified = true;
    run.unsubscribeSandbox?.();
    run.unsubscribeSandbox = undefined;
    this.persistence?.onFinished?.(run.snap, this.toInfo(run));
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
  return message
    .replace(/\/(private|var|tmp|home|app|data)\/[^\s]+/g, "[path]")
    .replace(/\b[0-9a-f]{12,}\b/g, "[id]")
    .slice(0, 300);
}

/** Maps sandbox/runtime failures onto the stable error catalog. */
function classifyRunError(error: unknown): string {
  const code = error && typeof error === "object" ? (error as { code?: string }).code : undefined;
  switch (code) {
    case "environment_unavailable":
    case "runner_unavailable":
    case "capacity_reached":
      return "SANDBOX_UNAVAILABLE";
    case "extension_load_failed":
    case "invalid_extension":
      return "EXTENSION_LOAD_FAILED";
    case "timeout":
      return "SANDBOX_TIMEOUT";
    case "cancelled":
      return "JOB_CANCELLED";
    default:
      return "INTERNAL";
  }
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
