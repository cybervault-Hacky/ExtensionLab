"use client";

import { Check } from "lucide-react";
import { useTheme } from "@/components/theme/ThemeProvider";
import { cn } from "@/lib/utils";
import { ACCENTS } from "@/lib/theme/theme";

export function AccentSelector() {
  const { accent, setAccent } = useTheme();

  return (
    <div>
      <div className="mb-3 text-sm font-medium">Accent</div>
      <div
        role="radiogroup"
        aria-label="Accent colour"
        className="flex flex-wrap gap-3"
      >
        {ACCENTS.map((item) => {
          const active = accent === item.key;
          return (
            <button
              key={item.key}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={item.label}
              title={item.label}
              onClick={() => setAccent(item.key)}
              className={cn(
                "group relative flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full border-2 p-[3px] transition-all",
                active
                  ? "border-[var(--accent)]"
                  : "border-transparent hover:border-[var(--border)]",
              )}
            >
              <span
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-white"
                style={{ backgroundColor: item.hex }}
              >
                {active ? (
                  <Check className="h-4 w-4" aria-hidden="true" />
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
