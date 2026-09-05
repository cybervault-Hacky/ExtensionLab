"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { MotionConfig } from "framer-motion";
import {
  ACCENTS,
  type AccentKey,
  getAccentDefinition,
  getStoredAccent,
  getStoredTheme,
  hydrateTheme,
  resolvedTheme,
  setAccentPreference,
  setThemePreference,
  type ThemeMode,
} from "@/lib/theme/theme";

export interface ThemeContextValue {
  theme: ThemeMode;
  accent: AccentKey;
  resolved: "light" | "dark";
  isHydrated: boolean;
  setTheme: (mode: ThemeMode) => void;
  setAccent: (accent: AccentKey) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({
  children,
  initialTheme,
  initialAccent,
}: {
  children: ReactNode;
  initialTheme?: ThemeMode;
  initialAccent?: AccentKey;
}) {
  const [theme, setThemeState] = useState<ThemeMode>(initialTheme ?? "system");
  const [accent, setAccentState] = useState<AccentKey>(initialAccent ?? "blue");
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    const stored = hydrateTheme();
    setThemeState(stored.theme);
    setAccentState(stored.accent);
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    const listener = () => {
      if (theme === "system") {
        const resolved = resolvedTheme("system");
        document.documentElement.classList.toggle("dark", resolved === "dark");
        document.documentElement.setAttribute("data-theme", resolved);
        document.documentElement.style.colorScheme = resolved;
      }
    };
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [theme, isHydrated]);

  const value = useMemo<ThemeContextValue>(() => {
    const applyTheme = (mode: ThemeMode) => {
      setThemePreference(mode);
      setThemeState(mode);
      if (mode === "system") {
        const resolved = resolvedTheme("system");
        document.documentElement.style.colorScheme = resolved;
      }
    };

    const applyAccent = (key: AccentKey) => {
      const definition = getAccentDefinition(key);
      setAccentPreference(key);
      setAccentState(key);
      const root = document.documentElement;
      root.style.setProperty("--accent", definition.hex);
      root.style.setProperty("--accent-hover", definition.hover);
      root.style.setProperty("--accent-soft", definition.soft);
      root.style.setProperty("--accent-foreground", definition.foreground);
    };

    return {
      theme,
      accent,
      resolved: resolvedTheme(theme),
      isHydrated,
      setTheme: applyTheme,
      setAccent: applyAccent,
    };
  }, [theme, accent, isHydrated]);

  return (
    <MotionConfig reducedMotion="user">
      <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
    </MotionConfig>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider.");
  }
  return context;
}

export { getStoredTheme, getStoredAccent, ACCENTS };
