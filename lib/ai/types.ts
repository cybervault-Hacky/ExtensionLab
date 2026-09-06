/**
 * Phase 8 AI assistance — domain types.
 *
 * The AI layer is an *assistant* on top of the deterministic analyzers, the
 * runtime sandbox and the test engine. Nothing here is a security authority:
 * every structure below is either allowlisted evidence we send to a model or
 * a schema-validated answer we got back. Provider SDK objects never appear in
 * these types; adapters in `lib/ai/providers/*` normalize them.
 */

import type { AssertionType, TestActionType, TestCategory, TestSeverity } from "@/lib/testing/types";

export const AI_PROVIDER_NAMES = ["openai", "fake", "disabled"] as const;
export type AIProviderName = (typeof AI_PROVIDER_NAMES)[number];

export const AI_FEATURES = [
  "explain_finding",
  "explain_test_failure",
  "analyze_runtime_error",
  "summarize_report",
  "suggest_tests",
  "answer_report_question",
] as const;
export type AIFeature = (typeof AI_FEATURES)[number];

export type AIConfidence = "high" | "medium" | "low";

/** Kinds of ExtensionLab objects an AI answer may reference as evidence. */
export type AIEvidenceKind = "finding" | "test" | "diagnostic" | "file" | "event" | "network" | "report_section" | "permission";

/**
 * Link from an AI statement to a real ExtensionLab artefact. Ids are checked
 * against the context that was actually supplied, so the model cannot cite
 * evidence that does not exist.
 */
export interface AIEvidenceRef {
  kind: AIEvidenceKind;
  id: string;
  /** Short human label copied from the context (never model-invented). */
  label: string;
}

// ---------------------------------------------------------------------------
// Sanitized context (what the model is allowed to see)

export interface FindingContext {
  id: string;
  source: "static" | "diagnostic";
  severity: string;
  category: string;
  title: string;
  message: string;
  recommendation?: string;
  evidence?: string[];
  relatedTestId?: string;
  sourceFile?: string;
}

export interface PermissionContext {
  name: string;
  kind: "permission" | "host_permission" | "optional_permission";
  broad: boolean;
  reason?: string;
}

export interface TestAssertionContext {
  type: string;
  passed: boolean;
  message: string;
  selector?: string;
  value?: string;
}

export interface TestEvidenceContext {
  id: string;
  kind: string;
  label: string;
  detail?: string;
}

export interface TestResultContext {
  testId: string;
  name: string;
  description: string;
  category: string;
  status: string;
  durationMs: number;
  steps: string[];
  assertions: TestAssertionContext[];
  evidence: TestEvidenceContext[];
  errors: string[];
  warnings: string[];
  skippedReason?: string;
}

export interface RuntimeEventContext {
  id: string;
  timestamp: number;
  type: string;
  level?: string;
  source?: string;
  message: string;
}

export interface NetworkEntryContext {
  id: string;
  method: string;
  url: string;
  status: number | null;
  resourceType?: string;
}

export interface ExtensionContext {
  name: string | null;
  version: string | null;
  manifestVersion: string | null;
  permissions: PermissionContext[];
  /** Allowlisted manifest facts only (never the raw manifest). */
  features: string[];
  fileCount: number | null;
  /** Up to a few dozen file paths; used for evidence linking only. */
  files: string[];
}

export interface ScoreContext {
  healthScore: number | null;
  runtimeScore: number | null;
  overallScore: number | null;
  categories: Array<{ key: string; label: string; score: number }>;
}

export interface RunSummaryContext {
  runId: string;
  outcome: string | null;
  status: string;
  total: number;
  passed: number;
  failed: number;
  warnings: number;
  skipped: number;
  timeout: number;
  error: number;
  reason?: string | null;
}

/** Everything a prompt may reference. Built only by `lib/ai/context.ts`. */
export interface AIContext {
  /** What the request is about; drives ownership and evidence validation. */
  resource: { kind: "report" | "test_run" | "snapshot" | "browser_session"; id: string };
  extension: ExtensionContext;
  scores: ScoreContext | null;
  findings: FindingContext[];
  tests: TestResultContext[];
  run: RunSummaryContext | null;
  events: RuntimeEventContext[];
  network: NetworkEntryContext[];
  /** Feature-specific focus (the finding/test the user asked about). */
  focus: { findingId?: string; testId?: string; question?: string; eventIds?: string[] };
  /** Ids the model may cite, grouped by kind. */
  evidenceIndex: AIEvidenceRef[];
  /** Budget accounting, for logs/metrics only. */
  bytes: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Structured outputs (validated by lib/ai/schema.ts)

export interface AIExplanation {
  kind: "explanation";
  summary: string;
  meaning: string;
  whyItMatters: string;
  impact: string;
  likelyCauses: string[];
  recommendations: string[];
  nextStep: string;
  evidence: AIEvidenceRef[];
  confidence: AIConfidence;
  /** Set when the model states the evidence is insufficient for a firm conclusion. */
  caveats: string[];
}

export interface AISummary {
  kind: "summary";
  headline: string;
  overallAssessment: string;
  strengths: string[];
  risks: string[];
  priorities: string[];
  evidence: AIEvidenceRef[];
  confidence: AIConfidence;
  caveats: string[];
}

export interface AISuggestedTest {
  id: string;
  name: string;
  description: string;
  category: TestCategory;
  severity: TestSeverity;
  timeout: number;
  steps: Array<{ type: TestActionType; selector?: string; value?: string; milliseconds?: number; url?: string }>;
  assertions: Array<{ type: AssertionType; selector?: string; value?: string; expectedStatus?: number; message?: string }>;
  rationale: string;
  evidence: AIEvidenceRef[];
}

export interface AITestSuggestions {
  kind: "test_suggestions";
  summary: string;
  tests: AISuggestedTest[];
  /** Suggestions the validator rejected, with the reason (shown as such). */
  rejected: Array<{ name: string; reason: string }>;
  confidence: AIConfidence;
  caveats: string[];
}

export interface AIAnswer {
  kind: "answer";
  answer: string;
  /** True when the question cannot be answered from the supplied report. */
  outOfScope: boolean;
  evidence: AIEvidenceRef[];
  confidence: AIConfidence;
  caveats: string[];
}

export type AIOutput = AIExplanation | AISummary | AITestSuggestions | AIAnswer;

export interface AIUsageTokens {
  input: number | null;
  output: number | null;
}

// ---------------------------------------------------------------------------
// Provider contract

/** The only thing the service sends to a provider. Already redacted. */
export interface AIPrompt {
  feature: AIFeature;
  system: string;
  /** Serialized, delimited, untrusted data block + task instruction. */
  user: string;
  /** JSON schema name the provider should target (informational for the model). */
  schemaName: string;
  maxOutputTokens: number;
}

export interface AIProviderResult {
  /** Raw model text (expected to be JSON); validated by the service. */
  text: string;
  tokens: AIUsageTokens;
  model: string;
}

export interface AIProviderRequestOptions {
  signal: AbortSignal;
  timeoutMs: number;
  /** Correlation id for logs (never sent as user content). */
  requestId: string;
}

/**
 * Provider interface. One production adapter (OpenAI-compatible) and one
 * deterministic fake exist; the service never talks to a provider directly.
 * Feature methods are thin so adapters cannot accidentally add per-feature
 * prompt logic — the prompt is built centrally.
 */
export interface AIProvider {
  readonly name: AIProviderName;
  readonly model: string;
  explainFinding(prompt: AIPrompt, options: AIProviderRequestOptions): Promise<AIProviderResult>;
  explainTestFailure(prompt: AIPrompt, options: AIProviderRequestOptions): Promise<AIProviderResult>;
  summarizeReport(prompt: AIPrompt, options: AIProviderRequestOptions): Promise<AIProviderResult>;
  analyzeRuntimeError(prompt: AIPrompt, options: AIProviderRequestOptions): Promise<AIProviderResult>;
  suggestTests(prompt: AIPrompt, options: AIProviderRequestOptions): Promise<AIProviderResult>;
  answerReportQuestion(prompt: AIPrompt, options: AIProviderRequestOptions): Promise<AIProviderResult>;
}

/** Client-facing envelope returned by every /api/ai route. */
export interface AIResponseEnvelope<T extends AIOutput = AIOutput> {
  feature: AIFeature;
  result: T;
  meta: {
    provider: AIProviderName;
    model: string;
    cached: boolean;
    durationMs: number;
    createdAt: number;
    /** Fixed disclaimer, rendered by the UI. */
    disclaimer: string;
  };
}

export const AI_DISCLAIMER =
  "AI-generated guidance is based on the available ExtensionLab evidence. Verify recommendations before applying changes.";
