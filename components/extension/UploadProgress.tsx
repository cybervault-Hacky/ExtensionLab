"use client";

import { Check } from "lucide-react";
import { ANALYSIS_STEPS } from "@/lib/extension/analyzer";
import { Progress } from "@/components/ui/Progress";
import { cn } from "@/lib/utils";

export interface UploadProgressProps {
  currentStepId: string;
  ratio: number;
}

export function UploadProgress({
  currentStepId,
  ratio,
}: UploadProgressProps) {
  const currentIndex = Math.max(
    0,
    ANALYSIS_STEPS.findIndex((step) => step.id === currentStepId),
  );

  return (
    <div className="card card-pad">
      <p className="eyebrow mb-2">Processing</p>
      <h2 className="text-2xl font-semibold tracking-tight">
        Analyzing extension
      </h2>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        Everything happens locally in your browser.
      </p>

      <div className="mt-7">
        <Progress value={ratio * 100} label="Overall" />
      </div>

      <ul className="mt-7 space-y-3">
        {ANALYSIS_STEPS.map((step, index) => {
          const complete = step.progress <= Math.round(ratio * 100) || index < currentIndex;
          const active = step.id === currentStepId && !complete;
          return (
            <li
              key={step.id}
              className={cn(
                "flex items-center gap-3 rounded-xl px-3 py-2 text-sm",
                active
                  ? "bg-[var(--accent-soft)] text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)]",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold",
                  complete
                    ? "bg-[var(--status-success-soft)] text-[var(--status-success)]"
                    : active
                      ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                      : "bg-[var(--surface-secondary)] text-[var(--text-secondary)]",
                )}
              >
                {complete ? (
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  index + 1
                )}
              </span>
              <span className="font-medium">{step.label}</span>
              <span className="ml-auto text-xs tabular-nums">
                {step.progress}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
