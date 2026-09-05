"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { AIRequestPanel, BulletSection, TextSection } from "./AIPanel";
import { useAIRequest } from "./useAIRequest";
import type { AIAnswer, AIEvidenceRef, AIExplanation, AISummary, AITestSuggestions } from "./types";

/**
 * Feature components. Each one is on-demand (a button starts the request),
 * renders only the validated result, and never blocks or replaces the
 * deterministic content around it.
 */

function ExplanationBody({ result }: { result: AIExplanation }) {
  return (
    <>
      <p className="mt-3 text-sm font-medium">{result.summary}</p>
      <TextSection title="What it means" text={result.meaning} />
      <TextSection title="Why it was flagged" text={result.whyItMatters} />
      <TextSection title="Likely impact" text={result.impact} />
      <BulletSection title="Likely causes" items={result.likelyCauses} />
      <BulletSection title="Recommendations" items={result.recommendations} />
      <TextSection title="Suggested next step" text={result.nextStep} />
    </>
  );
}

/** "Explain with AI" for a static finding or runtime diagnostic in a report. */
export function ExplainFinding({ reportId, findingId, onJump, className }: { reportId: string; findingId: string; onJump?: (ref: AIEvidenceRef) => void; className?: string }) {
  const { state, run, reset } = useAIRequest<AIExplanation>("/api/ai/finding");
  const start = useCallback(() => void run({ reportId, findingId }), [run, reportId, findingId]);
  return (
    <AIRequestPanel state={state} action="Explain with AI" onRun={start} onRetry={reset} onJump={onJump} className={className}>
      {(result) => <ExplanationBody result={result} />}
    </AIRequestPanel>
  );
}

/** "Analyze failure" for one test inside a persisted run. */
export function AnalyzeTestFailure({ runId, testId, onJump, className }: { runId: string; testId: string; onJump?: (ref: AIEvidenceRef) => void; className?: string }) {
  const { state, run, reset } = useAIRequest<AIExplanation>("/api/ai/test-failure");
  const start = useCallback(() => void run({ runId, testId }), [run, runId, testId]);
  return (
    <AIRequestPanel state={state} action="Analyze failure" onRun={start} onRetry={reset} onJump={onJump} className={className}>
      {(result) => <ExplanationBody result={result} />}
    </AIRequestPanel>
  );
}

/** Runtime error analysis across a whole run (console errors, failed requests, failed tests). */
export function AnalyzeRuntimeErrors({ runId, onJump, className }: { runId: string; onJump?: (ref: AIEvidenceRef) => void; className?: string }) {
  const { state, run, reset } = useAIRequest<AIExplanation>("/api/ai/runtime-error");
  const start = useCallback(() => void run({ runId }), [run, runId]);
  return (
    <AIRequestPanel state={state} action="Analyze runtime errors" onRun={start} onRetry={reset} onJump={onJump} className={className}>
      {(result) => <ExplanationBody result={result} />}
    </AIRequestPanel>
  );
}

/** "Generate AI Summary" for a report. */
export function ReportSummary({ reportId, onJump, className }: { reportId: string; onJump?: (ref: AIEvidenceRef) => void; className?: string }) {
  const { state, run, reset } = useAIRequest<AISummary>("/api/ai/report-summary");
  const start = useCallback(() => void run({ reportId }), [run, reportId]);
  return (
    <AIRequestPanel state={state} action="Generate AI Summary" onRun={start} onRetry={reset} onJump={onJump} className={className}>
      {(result) => (
        <>
          <p className="mt-3 text-sm font-medium">{result.headline}</p>
          <p className="mt-2 text-sm">{result.overallAssessment}</p>
          <BulletSection title="Strengths" items={result.strengths} />
          <BulletSection title="Risks" items={result.risks} />
          <BulletSection title="Priorities" items={result.priorities} />
        </>
      )}
    </AIRequestPanel>
  );
}

/** "Ask about this report": one bounded question, one grounded answer. */
export function AskAboutReport({ reportId, onJump, className }: { reportId: string; onJump?: (ref: AIEvidenceRef) => void; className?: string }) {
  const { state, run, reset } = useAIRequest<AIAnswer>("/api/ai/report-question");
  const [question, setQuestion] = useState("");
  const submit = useCallback(() => {
    const trimmed = question.trim();
    if (trimmed.length < 3) return;
    void run({ reportId, question: trimmed });
  }, [question, reportId, run]);
  const busy = state.status === "loading";
  return (
    <div className={className}>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label htmlFor={`ai-question-${reportId}`} className="sr-only">
          Ask about this report
        </label>
        <input
          id={`ai-question-${reportId}`}
          value={question}
          onChange={(event) => setQuestion(event.target.value.slice(0, 500))}
          placeholder="Ask about this report, e.g. which finding should I fix first?"
          maxLength={500}
          disabled={busy}
          className="min-h-[44px] flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm"
        />
        <Button type="submit" variant="secondary" size="sm" loading={busy} disabled={question.trim().length < 3}>
          Ask
        </Button>
      </form>
      {state.status !== "idle" ? (
        <AIRequestPanel state={state} action="Ask" onRun={submit} onRetry={reset} onJump={onJump} className="mt-3">
          {(result) => (
            <>
              {result.outOfScope ? (
                <p className="mt-3 text-xs text-[var(--text-secondary)]">This question could not be answered from the report alone.</p>
              ) : null}
              <p className="mt-2 text-sm">{result.answer}</p>
            </>
          )}
        </AIRequestPanel>
      ) : null}
    </div>
  );
}

/** Validated test suggestions; displayed as data, never executed from here. */
export function SuggestTests({ reportId, snapshotId, onJump, className }: { reportId?: string; snapshotId?: string; onJump?: (ref: AIEvidenceRef) => void; className?: string }) {
  const { state, run, reset } = useAIRequest<AITestSuggestions>("/api/ai/suggest-tests");
  const start = useCallback(() => void run(reportId ? { reportId } : { snapshotId }), [run, reportId, snapshotId]);
  return (
    <AIRequestPanel state={state} action="Suggest tests with AI" onRun={start} onRetry={reset} onJump={onJump} className={className}>
      {(result) => (
        <>
          <p className="mt-3 text-sm font-medium">{result.summary}</p>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Each suggestion was checked against the test engine&apos;s action, selector and URL rules. Suggestions are not executed automatically.
          </p>
          <div className="mt-3 space-y-3">
            {result.tests.length === 0 ? <p className="text-sm text-[var(--text-secondary)]">No suggestions passed validation.</p> : null}
            {result.tests.map((test) => (
              <div key={test.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{test.name}</p>
                  <div className="flex gap-2">
                    <Badge tone="neutral" className="text-[11px]">{test.category}</Badge>
                    <Badge tone="neutral" className="text-[11px]">{test.severity}</Badge>
                  </div>
                </div>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">{test.description}</p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium text-[var(--accent)]">Steps and assertions</summary>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs">
                    {test.steps.map((step, index) => (
                      <li key={index}>
                        <code>{step.type}</code>
                        {step.selector ? <> · selector <code>{step.selector}</code></> : null}
                        {step.url ? <> · <code>{step.url}</code></> : null}
                        {typeof step.milliseconds === "number" ? <> · {step.milliseconds} ms</> : null}
                        {step.value ? <> · value &quot;{step.value}&quot;</> : null}
                      </li>
                    ))}
                  </ol>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                    {test.assertions.map((assertion, index) => (
                      <li key={index}>
                        <code>{assertion.type}</code>
                        {assertion.selector ? <> · <code>{assertion.selector}</code></> : null}
                        {assertion.value ? <> · &quot;{assertion.value}&quot;</> : null}
                        {typeof assertion.expectedStatus === "number" ? <> · status {assertion.expectedStatus}</> : null}
                      </li>
                    ))}
                  </ul>
                </details>
                {test.rationale ? <p className="mt-2 text-xs text-[var(--text-secondary)]">Why: {test.rationale}</p> : null}
              </div>
            ))}
          </div>
          {result.rejected.length > 0 ? (
            <div className="mt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Rejected by validation</p>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-[var(--text-secondary)]">
                {result.rejected.map((item, index) => (
                  <li key={index}>
                    {item.name}: {item.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </AIRequestPanel>
  );
}
