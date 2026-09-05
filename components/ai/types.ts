/**
 * Client-side mirrors of the validated AI response shapes (no provider
 * details, no prompts). Kept in sync with lib/ai/types.ts by the API.
 */

export type AIConfidence = "high" | "medium" | "low";

export interface AIEvidenceRef {
  kind: "finding" | "test" | "diagnostic" | "file" | "event" | "network" | "report_section" | "permission";
  id: string;
  label: string;
}

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
  category: string;
  severity: string;
  timeout: number;
  steps: Array<{ type: string; selector?: string; value?: string; milliseconds?: number; url?: string }>;
  assertions: Array<{ type: string; selector?: string; value?: string; expectedStatus?: number; message?: string }>;
  rationale: string;
  evidence: AIEvidenceRef[];
}

export interface AITestSuggestions {
  kind: "test_suggestions";
  summary: string;
  tests: AISuggestedTest[];
  rejected: Array<{ name: string; reason: string }>;
  confidence: AIConfidence;
  caveats: string[];
}

export interface AIAnswer {
  kind: "answer";
  answer: string;
  outOfScope: boolean;
  evidence: AIEvidenceRef[];
  confidence: AIConfidence;
  caveats: string[];
}

export type AIOutput = AIExplanation | AISummary | AITestSuggestions | AIAnswer;

export interface AIResponseEnvelope<T extends AIOutput = AIOutput> {
  feature: string;
  result: T;
  meta: {
    provider: string;
    model: string;
    cached: boolean;
    durationMs: number;
    createdAt: number;
    disclaimer: string;
  };
}

export const AI_DISCLAIMER =
  "AI-generated guidance is based on the available ExtensionLab evidence. Verify recommendations before applying changes.";
