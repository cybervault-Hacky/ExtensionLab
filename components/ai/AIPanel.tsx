"use client";

import type { ReactNode } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PaywallNotice } from "@/components/billing/PaywallNotice";
import type { AIRequestState } from "./useAIRequest";
import { AI_DISCLAIMER, type AIConfidence, type AIEvidenceRef, type AIOutput } from "./types";

/**
 * Shared presentation for AI features. Deterministic ExtensionLab results are
 * rendered by their own components; everything inside these panels is
 * labelled as AI interpretation so the two are never confused.
 */

export function AIBadge({ children = "AI interpretation" }: { children?: ReactNode }) {
  return (
    <Badge tone="neutral" className="gap-1 text-[11px]">
      <Sparkles className="h-3 w-3" aria-hidden="true" />
      {children}
    </Badge>
  );
}

export function VerifiedBadge() {
  return (
    <Badge tone="neutral" className="text-[11px]">
      Verified by ExtensionLab
    </Badge>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: AIConfidence }) {
  const label = confidence === "high" ? "High confidence" : confidence === "medium" ? "Medium confidence" : "Low confidence";
  return (
    <Badge tone="neutral" className="text-[11px]" title="How well the available evidence supports this interpretation. Not a guarantee.">
      {label}
    </Badge>
  );
}

export function AIDisclaimer({ text = AI_DISCLAIMER }: { text?: string }) {
  return <p className="mt-3 text-xs text-[var(--text-secondary)]">{text}</p>;
}

export function EvidenceList({ evidence, onJump }: { evidence: AIEvidenceRef[]; onJump?: (ref: AIEvidenceRef) => void }) {
  if (evidence.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Evidence referenced</p>
      <ul className="mt-1 flex flex-wrap gap-2">
        {evidence.map((ref) => {
          const label = `${kindLabel(ref.kind)}: ${ref.label}`;
          const anchor = evidenceAnchor(ref);
          return (
            <li key={`${ref.kind}:${ref.id}`}>
              {anchor || onJump ? (
                <a
                  href={anchor ? `#${anchor}` : undefined}
                  onClick={onJump ? (event) => { event.preventDefault(); onJump(ref); } : undefined}
                  className="inline-flex max-w-full items-center rounded-full border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--accent)] hover:bg-[var(--surface-secondary)]"
                >
                  <span className="truncate">{label}</span>
                </a>
              ) : (
                <span className="inline-flex max-w-full items-center rounded-full border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--text-secondary)]">
                  <span className="truncate">{label}</span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Stable DOM ids used by report/test views so evidence chips can jump to the item. */
export function evidenceAnchor(ref: AIEvidenceRef): string | null {
  const safe = ref.id.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 80);
  switch (ref.kind) {
    case "finding":
      return `finding-${safe}`;
    case "diagnostic":
      return `diagnostic-${safe}`;
    case "test":
      return `test-${safe}`;
    case "report_section":
      return `section-${safe}`;
    default:
      return null;
  }
}

function kindLabel(kind: AIEvidenceRef["kind"]): string {
  switch (kind) {
    case "finding":
      return "Finding";
    case "diagnostic":
      return "Diagnostic";
    case "test":
      return "Test";
    case "file":
      return "File";
    case "event":
      return "Runtime event";
    case "network":
      return "Network";
    case "report_section":
      return "Report section";
    case "permission":
      return "Permission";
  }
}

export function Caveats({ caveats }: { caveats: string[] }) {
  if (caveats.length === 0) return null;
  return (
    <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Caveats</p>
      <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-[var(--text-secondary)]">
        {caveats.map((caveat, index) => (
          <li key={index}>{caveat}</li>
        ))}
      </ul>
    </div>
  );
}

export function BulletSection({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{title}</p>
      <ul className="mt-1 list-disc space-y-1 pl-4 text-sm">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export function TextSection({ title, text }: { title: string; text: string }) {
  if (!text) return null;
  return (
    <div className="mt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{title}</p>
      <p className="mt-1 text-sm">{text}</p>
    </div>
  );
}

/**
 * Wraps the request lifecycle: idle (button), loading, paywall, unavailable,
 * error, and the rendered result. `children` renders the success payload.
 */
export function AIRequestPanel<T extends AIOutput>({
  state,
  action,
  onRun,
  onRetry,
  onJump,
  children,
  className,
}: {
  state: AIRequestState<T>;
  action: string;
  onRun: () => void;
  onRetry?: () => void;
  onJump?: (ref: AIEvidenceRef) => void;
  children: (result: T, meta: { cached: boolean; disclaimer: string }) => ReactNode;
  className?: string;
}) {
  if (state.status === "idle") {
    return (
      <div className={className}>
        <Button variant="secondary" size="sm" onClick={onRun}>
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          {action}
        </Button>
      </div>
    );
  }
  if (state.status === "loading") {
    return (
      <div className={className} role="status" aria-live="polite">
        <p className="inline-flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Analyzing…
        </p>
      </div>
    );
  }
  if (state.status === "paywall") {
    return (
      <div className={className}>
        <PaywallNotice info={state.paywall} />
      </div>
    );
  }
  if (state.status === "unavailable" || state.status === "error") {
    return (
      <div className={className} role="status">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] p-3 text-sm">
          <p>{state.message}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {onRetry ? (
              <Button variant="ghost" size="sm" onClick={onRetry}>
                Try again
              </Button>
            ) : null}
            {state.referenceId ? <span className="text-xs text-[var(--text-secondary)]">Reference: {state.referenceId}</span> : null}
          </div>
        </div>
      </div>
    );
  }
  const { result, meta } = state.data;
  return (
    <div className={className}>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <AIBadge>AI-assisted</AIBadge>
          <ConfidenceBadge confidence={result.confidence} />
          {meta.cached ? <Badge tone="neutral" className="text-[11px]">Previously generated</Badge> : null}
        </div>
        {children(result, { cached: meta.cached, disclaimer: meta.disclaimer })}
        <EvidenceList evidence={"evidence" in result ? result.evidence : []} onJump={onJump} />
        <Caveats caveats={result.caveats} />
        <AIDisclaimer text={meta.disclaimer} />
      </div>
    </div>
  );
}
