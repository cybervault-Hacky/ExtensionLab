"use client";

import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

export interface ProgressProps extends ComponentPropsWithoutRef<"div"> {
  value: number;
  label?: string;
  showValue?: boolean;
  tone?: "accent" | "success" | "warning" | "error";
}

const tones = {
  accent: "bg-[var(--accent)]",
  success: "bg-[var(--status-success)]",
  warning: "bg-[var(--status-warning)]",
  error: "bg-[var(--status-error)]",
} as const;

export function Progress({
  value,
  label,
  showValue = true,
  tone = "accent",
  className,
  ...props
}: ProgressProps) {
  const normalized = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("w-full", className)} {...props}>
      {label ? (
        <div className="mb-2 flex items-center justify-between gap-4">
          <span className="text-sm font-medium text-[var(--text-primary)]">
            {label}
          </span>
          {showValue ? (
            <span className="text-sm tabular-nums text-[var(--text-secondary)]">
              {Math.round(normalized)}%
            </span>
          ) : null}
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-valuenow={Math.round(normalized)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? "Progress"}
        className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-secondary)]"
      >
        <div
          className={cn("h-full rounded-full transition-all duration-300", tones[tone])}
          style={{ width: `${normalized}%` }}
        />
      </div>
    </div>
  );
}
