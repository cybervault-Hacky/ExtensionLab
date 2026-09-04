"use client";

import { cn } from "@/lib/utils";

export function Logo({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <svg
        width="28"
        height="28"
        viewBox="0 0 28 28"
        fill="none"
        aria-hidden="true"
        className="shrink-0"
      >
        <rect
          x="1.5"
          y="1.5"
          width="25"
          height="25"
          rx="7"
          fill="var(--surface-secondary)"
          stroke="var(--accent)"
          strokeWidth="1.6"
        />
        <path
          d="M9 9.5h10M9 14h7.5M9 18.5h10"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      {!compact ? (
        <span className="text-[17px] font-semibold tracking-tight text-[var(--text-primary)]">
          ExtensionLab
        </span>
      ) : null}
    </span>
  );
}
