"use client";

import { Check } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/utils";
import type { PlanView } from "./types";

export interface PlanCardProps {
  plan: PlanView;
  current?: boolean;
  recommended?: boolean;
  /** Label and behaviour of the primary action; omit for none. */
  action?: { label: string; onClick?: () => void; href?: string; disabled?: boolean; loading?: boolean; variant?: "accent" | "secondary" | "primary" };
  footnote?: string | null;
}

export function PlanCard({ plan, current = false, recommended = false, action, footnote }: PlanCardProps) {
  return (
    <Card className={cn("flex h-full flex-col", recommended && "border-[var(--accent)]")}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold tracking-tight">{plan.name}</h3>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">{plan.audience}</p>
        </div>
        {current ? <Badge tone="accent">Current</Badge> : recommended ? <Badge tone="info">Recommended</Badge> : null}
      </div>
      <p className="mt-5 flex items-baseline gap-1">
        <span className="text-3xl font-semibold tracking-tight tabular-nums">{plan.price.formatted}</span>
        {plan.price.amount !== null && plan.price.amount > 0 ? <span className="text-sm text-[var(--text-secondary)]">/ month</span> : null}
      </p>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">{plan.description}</p>
      <ul className="mt-5 flex-1 space-y-2.5">
        {plan.highlights.map((item) => (
          <li key={item} className="flex items-start gap-2.5 text-sm">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" aria-hidden="true" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
      {action ? (
        <div className="mt-6">
          <Button
            variant={action.variant ?? (recommended ? "accent" : "secondary")}
            fullWidth
            href={action.href}
            onClick={action.onClick}
            disabled={action.disabled}
            loading={action.loading}
            aria-label={`${action.label}: ${plan.name}`}
          >
            {action.label}
          </Button>
        </div>
      ) : null}
      {footnote ? <p className="mt-3 text-center text-xs text-[var(--text-secondary)]">{footnote}</p> : null}
    </Card>
  );
}
