/**
 * Phase 8 AI assistance — public surface for routes and server code.
 *
 * Routes import from here only. Provider adapters, prompts and validators
 * are internal to `lib/ai`.
 */
export { runAIFeature, type AIRequest } from "./service";
export { getAISettings, isAIConfigured } from "./config";
export { isAIEnabled, getFakeAIProvider, setAIProviderForTests } from "./provider";
export { AIError, isAIError } from "./errors";
export { readBoundedJson } from "./limits";
export { buildContext, contextHash, type ContextSource } from "./context";
export { loadReportSource, loadTestRunSource, loadSnapshotSource } from "./sources";
export type { AIFeature, AIOutput, AIResponseEnvelope, AIExplanation, AISummary, AITestSuggestions, AIAnswer, AIEvidenceRef } from "./types";
export { AI_DISCLAIMER } from "./types";
