"use client";

import { useTheme } from "@/components/theme/ThemeProvider";
import { cn } from "@/lib/utils";
import type { ThemeMode } from "@/lib/theme/theme";

const options: Array<{ value: ThemeMode; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function ThemeSelector() {
  const { theme, setTheme } = useTheme();

  return (
    <div>
      <div className="mb-3 text-sm font-medium">Appearance</div>
      <div
        role="radiogroup"
        aria-label="Appearance"
        className="inline-flex w-full max-w-sm overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface-secondary)] p-1"
      >
        {options.map((option) => {
          const active = theme === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setTheme(option.value)}
              className={cn(
                "min-h-[44px] flex-1 rounded-full px-4 text-sm font-medium transition-colors",
                active
                  ? "bg-[var(--surface)] text-[var(--text-primary)] shadow-soft"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
