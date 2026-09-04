"use client";

import { Progress } from "@/components/ui/Progress";
import { cn } from "@/lib/utils";
import type { ExtensionAnalysis } from "@/types/extension";

export function HealthScore({
  analysis,
}: {
  analysis: ExtensionAnalysis;
}) {
  const { total, categories } = analysis.healthScore;

  return (
    <section className="card card-pad">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Health</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">
            Extension health
          </h2>
        </div>
        <div className="text-right">
          <span className="text-3xl font-semibold tabular-nums tracking-tight">
            {total}
          </span>
          <span className="text-lg font-medium text-[var(--text-secondary)]">
            /100
          </span>
        </div>
      </div>

      <div className="space-y-4">
        {categories.map((category) => (
          <CategoryProgress
            key={category.key}
            label={category.label}
            score={category.score}
          />
        ))}
      </div>

      <p className="mt-5 border-t border-[var(--border)] pt-4 text-xs leading-relaxed text-[var(--text-secondary)]">
        Health score is based on ExtensionLab&apos;s Phase 1 checks. It is not an
        industry-standard security score.
      </p>
    </section>
  );
}

function CategoryProgress({
  label,
  score,
}: {
  label: string;
  score: number;
}) {
  const tone = score >= 94 ? "success" : score >= 75 ? "accent" : "warning";
  const color =
    tone === "success"
      ? "text-[var(--status-success)]"
      : tone === "warning"
        ? "text-[var(--status-warning)]"
        : "text-[var(--text-primary)]";
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-4">
        <span className="text-sm font-medium">{label}</span>
        <span className={cn("text-sm font-semibold tabular-nums", color)}>
          {score}%
        </span>
      </div>
      <Progress value={score} tone={tone} />
    </div>
  );
}
