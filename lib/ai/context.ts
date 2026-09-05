import { createHash } from "node:crypto";
import { truncate } from "@/lib/runtime/redact";
import type { DiagnosticFinding, TestResult } from "@/lib/testing/types";
import type { AnalyzerIssue, CategoryScore, ExtensionAnalysis, PermissionInfo, PermissionsAnalysis } from "@/types/extension";
import { AIError } from "./errors";
import { redactForAI, redactUrlForAI } from "./redaction";
import type {
  AIContext,
  AIEvidenceRef,
  AIFeature,
  ExtensionContext,
  FindingContext,
  NetworkEntryContext,
  PermissionContext,
  RunSummaryContext,
  RuntimeEventContext,
  ScoreContext,
  TestResultContext,
} from "./types";

/**
 * Context builders — the only place raw ExtensionLab records are turned into
 * model input.
 *
 * Rules:
 *  - allowlisted fields only (never whole JSON blobs, never the raw manifest,
 *    never package bytes or file contents);
 *  - every string is redacted and length-limited;
 *  - counts are capped and the whole context must fit the byte budget; when
 *    it does not, the least relevant items are dropped first and the context
 *    is marked `truncated` so the model (and the UI) know evidence is partial;
 *  - every id the model may cite is listed in `evidenceIndex`.
 */

export const CONTEXT_LIMITS = {
  MAX_FINDINGS: 40,
  MAX_TESTS: 32,
  MAX_EVENTS: 60,
  MAX_NETWORK: 40,
  MAX_FILES: 60,
  MAX_PERMISSIONS: 40,
  MAX_STEPS: 24,
  MAX_ASSERTIONS: 16,
  MAX_EVIDENCE: 16,
  MAX_ERRORS: 10,
  MAX_QUESTION_CHARS: 500,
  TEXT: 400,
  LONG_TEXT: 800,
  SHORT_TEXT: 160,
} as const;

export const REPORT_SECTIONS: AIEvidenceRef[] = [
  { kind: "report_section", id: "scores", label: "Scores" },
  { kind: "report_section", id: "static-analysis", label: "Static analysis findings" },
  { kind: "report_section", id: "permissions", label: "Permissions" },
  { kind: "report_section", id: "runtime-tests", label: "Runtime test results" },
  { kind: "report_section", id: "diagnostics", label: "Runtime diagnostics" },
];

const text = (value: unknown, max: number = CONTEXT_LIMITS.TEXT): string =>
  typeof value === "string" ? truncate(redactForAI(value), max) : "";
const optionalText = (value: unknown, max: number = CONTEXT_LIMITS.TEXT): string | undefined =>
  typeof value === "string" && value.length > 0 ? truncate(redactForAI(value), max) : undefined;
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

// ---------------------------------------------------------------------------
// Raw record shapes (defensive: stored JSON may predate the current types)

export interface ReportJsonLike {
  extension?: { name?: unknown; version?: unknown; manifestVersion?: unknown };
  staticAnalysis?: {
    healthScore?: unknown;
    issues?: unknown;
    permissions?: unknown;
    healthScoreCategories?: unknown;
  };
  runtimeTests?: {
    runId?: unknown;
    score?: unknown;
    status?: unknown;
    outcome?: unknown;
    reason?: unknown;
    summary?: Record<string, unknown>;
    details?: { results?: unknown; diagnostics?: unknown; score?: unknown } | null;
  } | null;
  overallScore?: unknown;
}

export interface RunJsonLike {
  results?: unknown;
  diagnostics?: unknown;
  score?: { total?: unknown; categories?: unknown } | null;
  outcome?: unknown;
}

export interface RuntimeLogLike {
  events?: Array<{ timestamp?: unknown; type?: unknown; level?: unknown; source?: unknown; message?: unknown }>;
}

export interface NetworkSummaryLike {
  requests?: Array<{ timestamp?: unknown; method?: unknown; url?: unknown; status?: unknown; resourceType?: unknown }>;
}

export interface ContextSource {
  resource: AIContext["resource"];
  extension: { name: string | null; version: string | null; manifestVersion: string | null };
  analysis?: Partial<ExtensionAnalysis> | null;
  report?: ReportJsonLike | null;
  run?: {
    row: {
      id: string;
      status: string;
      outcome?: string | null;
      reason?: string | null;
      total: number;
      passed: number;
      failed: number;
      warnings: number;
      skipped: number;
      timeout: number;
      error_count: number;
      score: number;
    };
    json: RunJsonLike | null;
    diagnostics?: DiagnosticFinding[] | null;
    runtimeLog?: RuntimeLogLike | null;
    network?: NetworkSummaryLike | null;
  } | null;
}

export interface BuildOptions {
  feature: AIFeature;
  maxBytes: number;
  focus?: { findingId?: string; testId?: string; question?: string };
}

// ---------------------------------------------------------------------------
// Element builders

function permissionContexts(source: PermissionsAnalysis | Partial<PermissionsAnalysis> | undefined | null): PermissionContext[] {
  if (!source) return [];
  const categorized = Array.isArray(source.categorized) ? (source.categorized as PermissionInfo[]) : [];
  if (categorized.length > 0) {
    return categorized.slice(0, CONTEXT_LIMITS.MAX_PERMISSIONS).map((p) => ({
      name: text(p.name, CONTEXT_LIMITS.SHORT_TEXT),
      kind: p.kind === "host_permission" || p.kind === "optional_permission" ? p.kind : "permission",
      broad: Boolean(p.broad),
      reason: optionalText(p.reason, CONTEXT_LIMITS.SHORT_TEXT),
    }));
  }
  const plain: PermissionContext[] = [];
  for (const name of Array.isArray(source.permissions) ? source.permissions : []) {
    plain.push({ name: text(name, CONTEXT_LIMITS.SHORT_TEXT), kind: "permission", broad: false });
  }
  for (const name of Array.isArray(source.hostPermissions) ? source.hostPermissions : []) {
    plain.push({ name: text(name, CONTEXT_LIMITS.SHORT_TEXT), kind: "host_permission", broad: /<all_urls>|\*:\/\/\*/.test(String(name)) });
  }
  return plain.slice(0, CONTEXT_LIMITS.MAX_PERMISSIONS);
}

function manifestFeatures(analysis: Partial<ExtensionAnalysis> | null | undefined): string[] {
  const features = analysis?.manifest?.features;
  if (!features || typeof features !== "object") return [];
  return Object.entries(features)
    .filter(([, present]) => present === true)
    .map(([name]) => name)
    .slice(0, 20);
}

function filePaths(analysis: Partial<ExtensionAnalysis> | null | undefined): string[] {
  const entries = analysis?.files?.entries;
  if (!Array.isArray(entries)) return [];
  const files = entries.filter((entry) => entry && entry.type === "file" && typeof entry.path === "string").map((entry) => entry.path);
  // manifest and scripts first: they are what findings and tests refer to.
  const rank = (path: string) => (path.endsWith("manifest.json") ? 0 : /\.(js|mjs|ts)$/.test(path) ? 1 : /\.(html|css|json)$/.test(path) ? 2 : 3);
  return files
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .slice(0, CONTEXT_LIMITS.MAX_FILES)
    .map((path) => text(path, CONTEXT_LIMITS.SHORT_TEXT));
}

/** Upper bound on items read from stored JSON before feature-specific capping (memory guard). */
const HARD_CAP = 400;

function prioritize<T>(items: T[], isFocused: (item: T) => boolean, max: number): T[] {
  const focused = items.filter(isFocused);
  const rest = items.filter((item) => !isFocused(item));
  return [...focused, ...rest].slice(0, max);
}

function staticFindings(issues: unknown): FindingContext[] {
  if (!Array.isArray(issues)) return [];
  return (issues as AnalyzerIssue[])
    .filter((issue) => issue && typeof issue === "object" && typeof issue.id === "string")
    .slice(0, HARD_CAP)
    .map((issue) => ({
      id: text(issue.id, CONTEXT_LIMITS.SHORT_TEXT),
      source: "static" as const,
      severity: text(issue.severity, 24),
      category: text(issue.category, 40),
      title: text(issue.title, CONTEXT_LIMITS.SHORT_TEXT),
      message: text(issue.message, CONTEXT_LIMITS.LONG_TEXT),
    }));
}

function diagnosticFindings(diagnostics: unknown): FindingContext[] {
  if (!Array.isArray(diagnostics)) return [];
  return (diagnostics as DiagnosticFinding[])
    .filter((item) => item && typeof item === "object" && typeof item.id === "string")
    .slice(0, HARD_CAP)
    .map((item) => ({
      id: text(item.id, CONTEXT_LIMITS.SHORT_TEXT),
      source: "diagnostic" as const,
      severity: text(item.severity, 24),
      category: text(item.category, 40),
      title: text(item.title, CONTEXT_LIMITS.SHORT_TEXT),
      message: text(item.description, CONTEXT_LIMITS.LONG_TEXT),
      recommendation: optionalText(item.recommendation, CONTEXT_LIMITS.TEXT),
      evidence: Array.isArray(item.evidence) ? item.evidence.slice(0, 6).map((line) => text(line, CONTEXT_LIMITS.TEXT)) : undefined,
      relatedTestId: optionalText(item.relatedTestId, CONTEXT_LIMITS.SHORT_TEXT),
      sourceFile: optionalText(item.sourceFile, CONTEXT_LIMITS.SHORT_TEXT),
    }));
}

function testContexts(results: unknown): TestResultContext[] {
  if (!Array.isArray(results)) return [];
  return (results as TestResult[])
    .filter((result) => result && typeof result === "object" && typeof result.testId === "string")
    .slice(0, HARD_CAP)
    .map((result) => ({
      testId: text(result.testId, CONTEXT_LIMITS.SHORT_TEXT),
      name: text(result.name, CONTEXT_LIMITS.SHORT_TEXT),
      description: text(result.description, CONTEXT_LIMITS.TEXT),
      category: text(result.category, 40),
      status: text(result.status, 24),
      durationMs: num(result.duration) ?? 0,
      steps: (Array.isArray(result.steps) ? result.steps : []).slice(0, CONTEXT_LIMITS.MAX_STEPS).map((step) => text(step, CONTEXT_LIMITS.SHORT_TEXT)),
      assertions: (Array.isArray(result.assertions) ? result.assertions : []).slice(0, CONTEXT_LIMITS.MAX_ASSERTIONS).map((outcome) => ({
        type: text(outcome?.assertion?.type, 40),
        passed: Boolean(outcome?.passed),
        message: text(outcome?.message, CONTEXT_LIMITS.TEXT),
        selector: optionalText(outcome?.assertion?.selector, CONTEXT_LIMITS.SHORT_TEXT),
        value: optionalText(outcome?.assertion?.value, CONTEXT_LIMITS.SHORT_TEXT),
      })),
      evidence: (Array.isArray(result.evidence) ? result.evidence : [])
        .filter((item) => item && typeof item.id === "string")
        .slice(0, CONTEXT_LIMITS.MAX_EVIDENCE)
        .map((item) => ({
          id: text(item.id, CONTEXT_LIMITS.SHORT_TEXT),
          kind: text(item.kind, 24),
          label: text(item.label, CONTEXT_LIMITS.SHORT_TEXT),
          detail: item.kind === "screenshot" ? undefined : optionalText(item.detail, CONTEXT_LIMITS.TEXT),
        })),
      errors: (Array.isArray(result.errors) ? result.errors : []).slice(0, CONTEXT_LIMITS.MAX_ERRORS).map((line) => text(line, CONTEXT_LIMITS.TEXT)),
      warnings: (Array.isArray(result.warnings) ? result.warnings : []).slice(0, CONTEXT_LIMITS.MAX_ERRORS).map((line) => text(line, CONTEXT_LIMITS.TEXT)),
      skippedReason: optionalText(result.skippedReason, CONTEXT_LIMITS.TEXT),
    }));
}

function eventContexts(log: RuntimeLogLike | null | undefined): RuntimeEventContext[] {
  const events = Array.isArray(log?.events) ? log!.events! : [];
  const isInteresting = (event: { level?: unknown; type?: unknown }) =>
    event.level === "error" || event.level === "warn" || event.level === "warning" || event.type === "error" || event.type === "runtime";
  const picked = events.filter(isInteresting).slice(-CONTEXT_LIMITS.MAX_EVENTS);
  return picked.map((event, index) => ({
    id: `evt-${index + 1}`,
    timestamp: num(event.timestamp) ?? 0,
    type: text(event.type, 24) || "console",
    level: optionalText(event.level, 16),
    source: optionalText(event.source, CONTEXT_LIMITS.SHORT_TEXT),
    message: text(event.message, CONTEXT_LIMITS.LONG_TEXT),
  }));
}

function networkContexts(summary: NetworkSummaryLike | null | undefined): NetworkEntryContext[] {
  const requests = Array.isArray(summary?.requests) ? summary!.requests! : [];
  const failed = requests.filter((entry) => {
    const status = num(entry.status);
    return status === null || status === 0 || status >= 400;
  });
  return failed.slice(-CONTEXT_LIMITS.MAX_NETWORK).map((entry, index) => ({
    id: `net-${index + 1}`,
    method: text(entry.method, 12) || "GET",
    url: typeof entry.url === "string" ? truncate(redactUrlForAI(entry.url), CONTEXT_LIMITS.TEXT) : "",
    status: num(entry.status),
    resourceType: optionalText(entry.resourceType, 24),
  }));
}

function scoreContext(source: ContextSource): ScoreContext | null {
  const report = source.report;
  const categories: Array<{ key: string; label: string; score: number }> = [];
  const raw = report?.staticAnalysis?.healthScoreCategories ?? source.analysis?.healthScore?.categories;
  if (Array.isArray(raw)) {
    for (const category of raw as CategoryScore[]) {
      if (!category || typeof category !== "object") continue;
      categories.push({ key: text(category.key, 40), label: text(category.label, 60), score: num(category.score) ?? 0 });
    }
  }
  const healthScore = num(report?.staticAnalysis?.healthScore) ?? num(source.analysis?.healthScore?.total);
  const runtimeScore = num(report?.runtimeTests?.score) ?? (source.run ? num(source.run.row.score) : null);
  const overallScore = num(report?.overallScore);
  if (healthScore === null && runtimeScore === null && overallScore === null && categories.length === 0) return null;
  return { healthScore, runtimeScore, overallScore, categories: categories.slice(0, 12) };
}

function runSummary(source: ContextSource): RunSummaryContext | null {
  if (source.run) {
    const row = source.run.row;
    return {
      runId: row.id,
      outcome: row.outcome ?? (typeof source.run.json?.outcome === "string" ? source.run.json.outcome : null),
      status: row.status,
      total: row.total,
      passed: row.passed,
      failed: row.failed,
      warnings: row.warnings,
      skipped: row.skipped,
      timeout: row.timeout,
      error: row.error_count,
      reason: optionalText(row.reason, CONTEXT_LIMITS.TEXT) ?? null,
    };
  }
  const rt = source.report?.runtimeTests;
  if (!rt || typeof rt.runId !== "string") return null;
  const summary = rt.summary ?? {};
  return {
    runId: rt.runId,
    outcome: typeof rt.outcome === "string" ? rt.outcome : null,
    status: typeof rt.status === "string" ? rt.status : "unknown",
    total: num(summary.total) ?? 0,
    passed: num(summary.passed) ?? 0,
    failed: num(summary.failed) ?? 0,
    warnings: num(summary.warnings) ?? 0,
    skipped: num(summary.skipped) ?? 0,
    timeout: num(summary.timeout) ?? 0,
    error: num(summary.error) ?? 0,
    reason: optionalText(rt.reason, CONTEXT_LIMITS.TEXT) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Assembly

export function buildContext(source: ContextSource, options: BuildOptions): AIContext {
  const extension: ExtensionContext = {
    name: source.extension.name ? text(source.extension.name, CONTEXT_LIMITS.SHORT_TEXT) : null,
    version: source.extension.version ? text(source.extension.version, 40) : null,
    manifestVersion: source.extension.manifestVersion ? text(source.extension.manifestVersion, 16) : null,
    permissions: permissionContexts(
      (source.report?.staticAnalysis?.permissions as PermissionsAnalysis | undefined) ?? source.analysis?.permissions ?? null,
    ),
    features: manifestFeatures(source.analysis),
    fileCount: num(source.analysis?.files?.fileCount) ?? num(source.analysis?.metadata?.fileCount),
    files: filePaths(source.analysis),
  };

  const runJson = source.run?.json ?? (source.report?.runtimeTests?.details as RunJsonLike | null | undefined) ?? null;
  // The focused finding/test is always kept, even when the resource holds more
  // items than the context allows; everything else is capped in stored order.
  const findings = prioritize(
    [
      ...staticFindings(source.report?.staticAnalysis?.issues ?? source.analysis?.issues),
      ...diagnosticFindings(source.run?.diagnostics ?? runJson?.diagnostics),
    ],
    (finding) => finding.id === options.focus?.findingId,
    CONTEXT_LIMITS.MAX_FINDINGS,
  );
  const tests = prioritize(testContexts(runJson?.results), (test) => test.testId === options.focus?.testId, CONTEXT_LIMITS.MAX_TESTS);
  const events = eventContexts(source.run?.runtimeLog);
  const network = networkContexts(source.run?.network);

  const focus: AIContext["focus"] = {};
  if (options.focus?.findingId) focus.findingId = options.focus.findingId;
  if (options.focus?.testId) focus.testId = options.focus.testId;
  if (options.focus?.question) focus.question = truncate(redactForAI(options.focus.question), CONTEXT_LIMITS.MAX_QUESTION_CHARS);

  if (focus.findingId && !findings.some((finding) => finding.id === focus.findingId)) {
    throw new AIError("AI_UNAUTHORIZED_CONTEXT", { message: "Finding not found in this report." });
  }
  if (focus.testId && !tests.some((test) => test.testId === focus.testId)) {
    throw new AIError("AI_UNAUTHORIZED_CONTEXT", { message: "Test not found in this run." });
  }

  let context: AIContext = {
    resource: source.resource,
    extension,
    scores: scoreContext(source),
    findings,
    tests,
    run: runSummary(source),
    events,
    network,
    focus,
    evidenceIndex: [],
    bytes: 0,
    truncated: false,
  };

  context = shapeForFeature(context, options.feature);
  context = fitToBudget(context, options.maxBytes);
  context.evidenceIndex = buildEvidenceIndex(context);
  context.bytes = measure(context);
  if (context.bytes > options.maxBytes) {
    throw new AIError("AI_CONTEXT_TOO_LARGE");
  }
  return context;
}

/** Keeps what the feature needs and summarizes the rest. */
function shapeForFeature(context: AIContext, feature: AIFeature): AIContext {
  const summarizeTest = (test: TestResultContext): TestResultContext => ({
    ...test,
    description: truncate(test.description, CONTEXT_LIMITS.SHORT_TEXT),
    steps: [],
    assertions: test.assertions.filter((assertion) => !assertion.passed).slice(0, 4),
    evidence: [],
    errors: test.errors.slice(0, 2),
    warnings: test.warnings.slice(0, 2),
  });
  const summarizeFinding = (finding: FindingContext): FindingContext => ({
    id: finding.id,
    source: finding.source,
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    message: truncate(finding.message, CONTEXT_LIMITS.SHORT_TEXT),
    relatedTestId: finding.relatedTestId,
    sourceFile: finding.sourceFile,
  });

  switch (feature) {
    case "explain_finding": {
      const focused = context.findings.find((finding) => finding.id === context.focus.findingId)!;
      const relatedTest = focused.relatedTestId ? context.tests.filter((test) => test.testId === focused.relatedTestId) : [];
      return {
        ...context,
        findings: [focused, ...context.findings.filter((finding) => finding.id !== focused.id).slice(0, 12).map(summarizeFinding)],
        tests: relatedTest,
        events: [],
        network: [],
      };
    }
    case "explain_test_failure": {
      const focused = context.tests.find((test) => test.testId === context.focus.testId)!;
      const related = context.findings.filter((finding) => finding.relatedTestId === focused.testId);
      return {
        ...context,
        findings: [...related, ...context.findings.filter((finding) => finding.relatedTestId !== focused.testId).slice(0, 8).map(summarizeFinding)],
        tests: [focused, ...context.tests.filter((test) => test.testId !== focused.testId).map(summarizeTest)],
        events: context.events.slice(-20),
        network: context.network.slice(-10),
      };
    }
    case "analyze_runtime_error": {
      const failing = context.tests.filter((test) => ["failed", "error", "timeout", "warning"].includes(test.status));
      const rest = context.tests.filter((test) => !failing.includes(test));
      return {
        ...context,
        findings: context.findings.filter((finding) => finding.source === "diagnostic").concat(context.findings.filter((f) => f.source === "static").slice(0, 6).map(summarizeFinding)),
        tests: [...failing, ...rest.map(summarizeTest)],
      };
    }
    case "suggest_tests":
      return {
        ...context,
        findings: context.findings.map(summarizeFinding),
        tests: context.tests.map(summarizeTest),
        events: context.events.slice(-10),
        network: context.network.slice(-10),
      };
    case "summarize_report":
    case "answer_report_question":
    default:
      return {
        ...context,
        findings: context.findings.map((finding) => ({ ...finding, message: truncate(finding.message, CONTEXT_LIMITS.TEXT) })),
        tests: context.tests.map((test) => ({ ...summarizeTest(test), assertions: test.assertions.filter((a) => !a.passed).slice(0, 3) })),
        events: context.events.slice(-15),
        network: context.network.slice(-10),
      };
  }
}

function measure(context: AIContext): number {
  return new TextEncoder().encode(JSON.stringify({ ...context, bytes: 0 })).byteLength;
}

/** Drops the least relevant material until the context fits (or nothing is left to drop). */
function fitToBudget(input: AIContext, maxBytes: number): AIContext {
  let context = input;
  const focusedFinding = context.focus.findingId;
  const focusedTest = context.focus.testId;
  const trims: Array<(c: AIContext) => AIContext> = [
    (c) => ({ ...c, extension: { ...c.extension, files: c.extension.files.slice(0, 20) } }),
    (c) => ({ ...c, network: c.network.slice(-10), events: c.events.slice(-20) }),
    (c) => ({ ...c, tests: c.tests.map((t) => (t.testId === focusedTest ? t : { ...t, steps: [], evidence: [] })) }),
    (c) => ({ ...c, findings: c.findings.filter((f, i) => f.id === focusedFinding || i < 12) }),
    (c) => ({ ...c, tests: c.tests.filter((t, i) => t.testId === focusedTest || i < 8) }),
    (c) => ({ ...c, network: [], events: c.events.slice(-8), extension: { ...c.extension, files: c.extension.files.slice(0, 8) } }),
    (c) => ({ ...c, findings: c.findings.filter((f, i) => f.id === focusedFinding || i < 4), tests: c.tests.filter((t, i) => t.testId === focusedTest || i < 3) }),
    (c) => ({
      ...c,
      tests: c.tests.map((t) => ({ ...t, steps: t.steps.slice(0, 6), evidence: t.evidence.slice(0, 6), assertions: t.assertions.slice(0, 6), errors: t.errors.slice(0, 3) })),
      findings: c.findings.map((f) => ({ ...f, message: truncate(f.message, CONTEXT_LIMITS.TEXT), evidence: f.evidence?.slice(0, 3) })),
      events: c.events.map((e) => ({ ...e, message: truncate(e.message, CONTEXT_LIMITS.TEXT) })),
    }),
  ];
  for (const trim of trims) {
    if (measure(context) <= maxBytes) return context;
    context = { ...trim(context), truncated: true };
  }
  return context;
}

function buildEvidenceIndex(context: AIContext): AIEvidenceRef[] {
  const refs: AIEvidenceRef[] = [];
  for (const finding of context.findings) {
    refs.push({ kind: finding.source === "diagnostic" ? "diagnostic" : "finding", id: finding.id, label: finding.title });
  }
  for (const test of context.tests) refs.push({ kind: "test", id: test.testId, label: test.name });
  for (const path of context.extension.files) refs.push({ kind: "file", id: path, label: path });
  for (const finding of context.findings) {
    if (finding.sourceFile && !refs.some((ref) => ref.kind === "file" && ref.id === finding.sourceFile)) {
      refs.push({ kind: "file", id: finding.sourceFile, label: finding.sourceFile });
    }
  }
  for (const event of context.events) refs.push({ kind: "event", id: event.id, label: truncate(event.message, 80) });
  for (const entry of context.network) refs.push({ kind: "network", id: entry.id, label: `${entry.method} ${truncate(entry.url, 60)}` });
  for (const permission of context.extension.permissions) refs.push({ kind: "permission", id: permission.name, label: permission.name });
  refs.push(...REPORT_SECTIONS);
  return refs;
}

/** Stable fingerprint of the sanitized context (cache key material; contains no secrets by construction). */
export function contextHash(context: AIContext): string {
  return createHash("sha256").update(JSON.stringify({ ...context, bytes: 0 })).digest("hex");
}
