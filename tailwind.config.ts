import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--bg)",
        surface: "var(--surface)",
        "surface-secondary": "var(--surface-secondary)",
        foreground: "var(--text-primary)",
        secondary: "var(--text-secondary)",
        border: "var(--border)",
        accent: "var(--accent)",
        "accent-hover": "var(--accent-hover)",
        "accent-soft": "var(--accent-soft)",
        "accent-foreground": "var(--accent-foreground)",
        success: "var(--status-success)",
        warning: "var(--status-warning)",
        error: "var(--status-error)",
        info: "var(--status-info)",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          '"SF Pro Display"',
          '"SF Pro Text"',
          "Inter",
          "system-ui",
          "sans-serif",
        ],
      },
      boxShadow: {
        soft: "0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.04)",
        lifted: "0 2px 4px rgba(0,0,0,0.04), 0 18px 40px rgba(0,0,0,0.08)",
      },
      borderRadius: {
        xl: "1rem",
        "2xl": "1.25rem",
        "3xl": "1.75rem",
      },
    },
  },
  plugins: [],
};

export default config;
