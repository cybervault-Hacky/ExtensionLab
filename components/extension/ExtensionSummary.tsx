"use client";

import { motion } from "framer-motion";
import { Badge } from "@/components/ui/Badge";
import { formatBytes } from "@/lib/extension/limits";
import type { ExtensionAnalysis } from "@/types/extension";

export function ExtensionSummary({
  analysis,
}: {
  analysis: ExtensionAnalysis;
}) {
  const score = analysis.healthScore.total;
  const stroke = 2 * Math.PI * 42;
  const dash = stroke * (score / 100);

  return (
    <div className="card card-pad overflow-hidden">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="eyebrow mb-2">Extension summary</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {analysis.metadata.name ?? "Untitled extension"}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {analysis.metadata.version ? (
              <Badge tone="neutral">Version {analysis.metadata.version}</Badge>
            ) : null}
            <Badge tone="accent">{analysis.metadata.manifestVersionLabel}</Badge>
            <Badge tone="neutral">
              {analysis.files.fileCount} files
            </Badge>
            <Badge tone="neutral">
              {formatBytes(analysis.files.totalUncompressedSize)}
            </Badge>
          </div>
          {analysis.metadata.description ? (
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-[var(--text-secondary)]">
              {analysis.metadata.description}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-4 sm:flex-col">
          <div className="relative inline-flex h-[104px] w-[104px] items-center justify-center">
            <svg
              viewBox="0 0 100 100"
              className="h-full w-full -rotate-90"
              aria-hidden="true"
            >
              <circle
                cx="50"
                cy="50"
                r="42"
                fill="none"
                stroke="var(--surface-secondary)"
                strokeWidth="8"
              />
              <motion.circle
                cx="50"
                cy="50"
                r="42"
                fill="none"
                stroke="var(--accent)"
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={`${dash} ${stroke}`}
                initial={{ strokeDasharray: `0 ${stroke}` }}
                animate={{ strokeDasharray: `${dash} ${stroke}` }}
                transition={{ duration: 0.8, ease: "easeOut" }}
              />
            </svg>
            <div className="absolute text-center">
              <div className="text-2xl font-semibold tabular-nums">{score}</div>
              <div className="text-xs text-[var(--text-secondary)]">/ 100</div>
            </div>
          </div>
          <p className="text-sm font-medium">Extension Health</p>
        </div>
      </div>
    </div>
  );
}
