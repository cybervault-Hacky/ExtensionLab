import { redactForAI } from "./redaction";
import type { AIAnswer, AIConfidence, AIContext, AIEvidenceKind, AIEvidenceRef, AIExplanation, AIFeature, AIOutput, AISummary, AITestSuggestions } from "./types";

/**
 * Strict validation of model output. Anything that does not match the schema
 * for the feature is rejected as AI_INVALID_OUTPUT by the service — the UI
 * never receives partially valid or free-form model text.
 *
 * Every string is bounded and re-redacted (a model could echo something that
 * slipped past context redaction) and every evidence reference must point at
 * an id that was actually part of the supplied context.
 */

export const OUTPUT_LIMITS = {
  SHORT: 300,
  TEXT: 1200,
  LONG: 2400,
  LIST: 8,
  LIST_ITEM: 400,
  EVIDENCE: 12,
  CAVEATS: 6,
  SUGGESTED_TESTS: 8,
} as const;

export class SchemaViolation extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "SchemaViolation";
  }
}

const EVIDENCE_KINDS: readonly AIEvidenceKind[] = ["finding", "test", "diagnostic", "file", "event", "network", "report_section", "permission"];
const CONFIDENCE: readonly AIConfidence[] = ["high", "medium", "low"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(record: Record<string, unknown>, key: string, max: number, path: string, options: { optional?: boolean } = {}): string {
  const value = record[key];
  if (value === undefined || value === null) {
    if (options.optional) return "";
    throw new SchemaViolation(`${path}.${key}`, "missing");
  }
  if (typeof value !== "string") throw new SchemaViolation(`${path}.${key}`, "expected string");
  const cleaned = redactForAI(value.replace(/\s+/g, " ").trim());
  if (!options.optional && cleaned.length === 0) throw new SchemaViolation(`${path}.${key}`, "empty");
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function list(record: Record<string, unknown>, key: string, path: string, options: { max?: number; itemMax?: number; optional?: boolean } = {}): string[] {
  const value = record[key];
  if (value === undefined || value === null) {
    if (options.optional) return [];
    throw new SchemaViolation(`${path}.${key}`, "missing");
  }
  if (!Array.isArray(value)) throw new SchemaViolation(`${path}.${key}`, "expected array");
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new SchemaViolation(`${path}.${key}`, "expected string items");
    const cleaned = redactForAI(item.replace(/\s+/g, " ").trim());
    if (!cleaned) continue;
    out.push(cleaned.length > (options.itemMax ?? OUTPUT_LIMITS.LIST_ITEM) ? `${cleaned.slice(0, (options.itemMax ?? OUTPUT_LIMITS.LIST_ITEM) - 1)}…` : cleaned);
    if (out.length >= (options.max ?? OUTPUT_LIMITS.LIST)) break;
  }
  return out;
}

function confidence(record: Record<string, unknown>, path: string): AIConfidence {
  const value = record.confidence;
  if (typeof value !== "string" || !CONFIDENCE.includes(value as AIConfidence)) throw new SchemaViolation(`${path}.confidence`, "expected high|medium|low");
  return value as AIConfidence;
}

/**
 * Evidence: unknown kinds or ids not present in the context are *dropped*
 * (not fatal) so a single hallucinated reference does not discard an
 * otherwise valid explanation; labels are always taken from the context.
 */
export function validateEvidence(value: unknown, context: AIContext, path: string): AIEvidenceRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new SchemaViolation(`${path}.evidence`, "expected array");
  const out: AIEvidenceRef[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const kind = item.kind;
    const id = item.id;
    if (typeof kind !== "string" || typeof id !== "string") continue;
    if (!EVIDENCE_KINDS.includes(kind as AIEvidenceKind)) continue;
    const match = context.evidenceIndex.find((ref) => ref.kind === kind && ref.id === id);
    if (!match || seen.has(`${kind}:${id}`)) continue;
    seen.add(`${kind}:${id}`);
    out.push({ kind: match.kind, id: match.id, label: match.label });
    if (out.length >= OUTPUT_LIMITS.EVIDENCE) break;
  }
  return out;
}

export function parseModelJson(text: string): Record<string, unknown> {
  let body = text.trim();
  // Tolerate a fenced block around the JSON; nothing else.
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fenced) body = fenced[1].trim();
  if (!body.startsWith("{")) {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) throw new SchemaViolation("$", "not a JSON object");
    body = body.slice(start, end + 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SchemaViolation("$", "invalid JSON");
  }
  if (!isRecord(parsed)) throw new SchemaViolation("$", "expected object");
  return parsed;
}

export function validateExplanation(raw: Record<string, unknown>, context: AIContext): AIExplanation {
  const path = "$";
  return {
    kind: "explanation",
    summary: str(raw, "summary", OUTPUT_LIMITS.SHORT, path),
    meaning: str(raw, "meaning", OUTPUT_LIMITS.TEXT, path),
    whyItMatters: str(raw, "whyItMatters", OUTPUT_LIMITS.TEXT, path),
    impact: str(raw, "impact", OUTPUT_LIMITS.TEXT, path),
    likelyCauses: list(raw, "likelyCauses", path, { optional: true }),
    recommendations: list(raw, "recommendations", path),
    nextStep: str(raw, "nextStep", OUTPUT_LIMITS.SHORT, path),
    evidence: validateEvidence(raw.evidence, context, path),
    confidence: confidence(raw, path),
    caveats: list(raw, "caveats", path, { optional: true, max: OUTPUT_LIMITS.CAVEATS }),
  };
}

export function validateSummary(raw: Record<string, unknown>, context: AIContext): AISummary {
  const path = "$";
  return {
    kind: "summary",
    headline: str(raw, "headline", OUTPUT_LIMITS.SHORT, path),
    overallAssessment: str(raw, "overallAssessment", OUTPUT_LIMITS.LONG, path),
    strengths: list(raw, "strengths", path, { optional: true }),
    risks: list(raw, "risks", path, { optional: true }),
    priorities: list(raw, "priorities", path),
    evidence: validateEvidence(raw.evidence, context, path),
    confidence: confidence(raw, path),
    caveats: list(raw, "caveats", path, { optional: true, max: OUTPUT_LIMITS.CAVEATS }),
  };
}

export function validateAnswer(raw: Record<string, unknown>, context: AIContext): AIAnswer {
  const path = "$";
  if (typeof raw.outOfScope !== "boolean") throw new SchemaViolation(`${path}.outOfScope`, "expected boolean");
  return {
    kind: "answer",
    answer: str(raw, "answer", OUTPUT_LIMITS.LONG, path),
    outOfScope: raw.outOfScope,
    evidence: validateEvidence(raw.evidence, context, path),
    confidence: confidence(raw, path),
    caveats: list(raw, "caveats", path, { optional: true, max: OUTPUT_LIMITS.CAVEATS }),
  };
}

/**
 * Suggestions are validated in two stages: the JSON shape here, and each test
 * through the test-engine rules in `lib/ai/test-suggestions.ts` (action
 * allowlist, selectors, URLs, limits). `validateTest` is injected so this
 * module stays free of server-only imports.
 */
export function validateTestSuggestions(
  raw: Record<string, unknown>,
  context: AIContext,
  validateTest: (candidate: Record<string, unknown>, context: AIContext) => { ok: true; test: AITestSuggestions["tests"][number] } | { ok: false; name: string; reason: string },
): AITestSuggestions {
  const path = "$";
  if (!Array.isArray(raw.tests)) throw new SchemaViolation(`${path}.tests`, "expected array");
  const tests: AITestSuggestions["tests"] = [];
  const rejected: AITestSuggestions["rejected"] = [];
  const ids = new Set<string>();
  for (const candidate of raw.tests.slice(0, OUTPUT_LIMITS.SUGGESTED_TESTS * 2)) {
    if (!isRecord(candidate)) {
      rejected.push({ name: "Unnamed suggestion", reason: "The suggestion was not an object." });
      continue;
    }
    const verdict = validateTest(candidate, context);
    if (!verdict.ok) {
      rejected.push({ name: verdict.name, reason: verdict.reason });
      continue;
    }
    if (ids.has(verdict.test.id)) {
      rejected.push({ name: verdict.test.name, reason: "Duplicate test id." });
      continue;
    }
    ids.add(verdict.test.id);
    tests.push(verdict.test);
    if (tests.length >= OUTPUT_LIMITS.SUGGESTED_TESTS) break;
  }
  return {
    kind: "test_suggestions",
    summary: str(raw, "summary", OUTPUT_LIMITS.SHORT, path),
    tests,
    rejected: rejected.slice(0, OUTPUT_LIMITS.SUGGESTED_TESTS * 2),
    confidence: confidence(raw, path),
    caveats: list(raw, "caveats", path, { optional: true, max: OUTPUT_LIMITS.CAVEATS }),
  };
}

export function validateOutput(
  feature: AIFeature,
  raw: Record<string, unknown>,
  context: AIContext,
  validateTest: Parameters<typeof validateTestSuggestions>[2],
): AIOutput {
  switch (feature) {
    case "explain_finding":
    case "explain_test_failure":
    case "analyze_runtime_error":
      return validateExplanation(raw, context);
    case "summarize_report":
      return validateSummary(raw, context);
    case "suggest_tests":
      return validateTestSuggestions(raw, context, validateTest);
    case "answer_report_question":
      return validateAnswer(raw, context);
  }
}
