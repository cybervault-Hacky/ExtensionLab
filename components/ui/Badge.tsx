"use client";

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/lib/utils";

export type BadgeTone =
  | "default"
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "info"
  | "neutral";

export interface BadgeProps extends ComponentPropsWithoutRef<"span"> {
  tone?: BadgeTone;
  children?: ReactNode;
}

const tones: Record<BadgeTone, string> = {
  default: "bg-[var(--surface-secondary)] text-[var(--text-primary)] border-[var(--border)]",
  accent:
    "bg-[var(--accent-soft)] text-[var(--accent)] border-transparent",
  success:
    "bg-[var(--status-success)] text-[var(--bg)] border-transparent",
  warning:
    "bg-[var(--status-warning)] text-[var(--bg)] border-transparent",
  error: "bg-[var(--status-error)] text-[var(--bg)] border-transparent",
  info: "bg-[var(--accent-soft)] text-[var(--accent)] border-transparent",
  neutral: "bg-[var(--surface-secondary)] text-[var(--text-secondary)] border-[var(--border)]",
};

export function Badge({
  className,
  tone = "default",
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold",
        tones[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
