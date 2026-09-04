/**
 * Theme and accent provider logic.
 *
 * The selected accent, resolved theme, and persisted preferences are handled
 * here. Components should always read the CSS variables rather than hardcoding
 * colors.
 */

export type ThemeMode = "system" | "light" | "dark";
export type AccentKey =
  | "blue"
  | "purple"
  | "pink"
  | "red"
  | "orange"
  | "green"
  | "teal";

export interface AccentDefinition {
  key: AccentKey;
  label: string;
  hex: string;
  hover: string;
  soft: string;
  foreground: string;
  lightHover: string;
}

export const THEME_STORAGE_KEY = "extensionlab:theme";
export const ACCENT_STORAGE_KEY = "extensionlab:accent";

export const ACCENTS: AccentDefinition[] = [
  {
    key: "blue",
    label: "Blue",
    hex: "#0071E3",
    hover: "#0077ED",
    soft: "rgba(0, 113, 227, 0.13)",
    foreground: "#FFFFFF",
    lightHover: "#006EDB",
  },
  {
    key: "purple",
    label: "Purple",
    hex: "#8944AB",
    hover: "#8E4FB0",
    soft: "rgba(137, 68, 171, 0.14)",
    foreground: "#FFFFFF",
    lightHover: "#7E3FA0",
  },
  {
    key: "pink",
    label: "Pink",
    hex: "#D83684",
    hover: "#DB4C90",
    soft: "rgba(216, 54, 132, 0.14)",
    foreground: "#FFFFFF",
    lightHover: "#C92E7A",
  },
  {
    key: "red",
    label: "Red",
    hex: "#E0322F",
    hover: "#E44945",
    soft: "rgba(224, 50, 47, 0.14)",
    foreground: "#FFFFFF",
    lightHover: "#D02825",
  },
  {
    key: "orange",
    label: "Orange",
    hex: "#E97900",
    hover: "#F08314",
    soft: "rgba(233, 121, 0, 0.15)",
    foreground: "#FFFFFF",
    lightHover: "#D06D00",
  },
  {
    key: "green",
    label: "Green",
    hex: "#288C46",
    hover: "#329E50",
    soft: "rgba(40, 140, 70, 0.14)",
    foreground: "#FFFFFF",
    lightHover: "#247D3E",
  },
  {
    key: "teal",
    label: "Teal",
    hex: "#168C8C",
    hover: "#1CA3A3",
    soft: "rgba(22, 140, 140, 0.14)",
    foreground: "#FFFFFF",
    lightHover: "#117E7E",
  },
];

export const DEFAULT_ACCENT: AccentKey = "blue";
export const DEFAULT_THEME: ThemeMode = "system";

function applyAccent(def: AccentDefinition): void {
  const root = document.documentElement;
  root.style.setProperty("--accent", def.hex);
  root.style.setProperty("--accent-hover", def.hover);
  root.style.setProperty("--accent-soft", def.soft);
  root.style.setProperty("--accent-foreground", def.foreground);
}

function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system") return mode;
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyThemeClass(mode: ThemeMode): void {
  const resolved = resolveTheme(mode);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.style.colorScheme = resolved;
}

export function getStoredTheme(): ThemeMode {
  if (typeof window === "undefined") return DEFAULT_THEME;
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system"
    ? stored
    : DEFAULT_THEME;
}

export function getStoredAccent(): AccentKey {
  if (typeof window === "undefined") return DEFAULT_ACCENT;
  const stored = window.localStorage.getItem(ACCENT_STORAGE_KEY);
  return ACCENTS.some((accent) => accent.key === stored)
    ? (stored as AccentKey)
    : DEFAULT_ACCENT;
}

export function setThemePreference(mode: ThemeMode): void {
  window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  applyThemeClass(mode);
}

export function setAccentPreference(accent: AccentKey): void {
  const definition =
    ACCENTS.find((candidate) => candidate.key === accent) ?? ACCENTS[0];
  window.localStorage.setItem(ACCENT_STORAGE_KEY, accent);
  applyAccent(definition);
}

export function getAccentDefinition(accent: AccentKey): AccentDefinition {
  return ACCENTS.find((candidate) => candidate.key === accent) ?? ACCENTS[0];
}

/** Apply persisted preferences and return the resolved theme. */
export function hydrateTheme(): {
  theme: ThemeMode;
  accent: AccentKey;
} {
  const theme = getStoredTheme();
  const accent = getStoredAccent();
  applyThemeClass(theme);
  applyAccent(getAccentDefinition(accent));
  return { theme, accent };
}

export function resolvedTheme(mode: ThemeMode): "light" | "dark" {
  return resolveTheme(mode);
}
