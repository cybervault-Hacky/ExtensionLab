"use client";

import { Check, Info, TriangleAlert, X } from "lucide-react";
import type { StatusKind } from "@/types/extension";

const statusMap: Record<StatusKind, {
  label: string;
  tone: "success" | "warning" | "error" | "info";
  icon: typeof Check;
  colorClass: string;
}> = {
  passed: {
    label: "Passed",
    tone: "success",
    icon: Check,
    colorClass: "text-[var(--status-success)]",
  },
  warning: {
    label: "Review",
    tone: "warning",
    icon: TriangleAlert,
    colorClass: "text-[var(--status-warning)]",
  },
  failed: {
    label: "Failed",
    tone: "error",
    icon: X,
    colorClass: "text-[var(--status-error)]",
  },
  info: {
    label: "Info",
    tone: "info",
    icon: Info,
    colorClass: "text-[var(--status-info)]",
  },
};

export function StatusBadge({ status }: { status: StatusKind }) {
  const config = statusMap[status];
  const Icon = config.icon;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium">
      <span className={`inline-flex h-5 w-5 items-center justify-center ${config.colorClass}`}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span>{config.label}</span>
    </span>
  );
}
