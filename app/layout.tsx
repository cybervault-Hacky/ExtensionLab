import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import "./globals.css";
import { ThemeProvider } from "@/components/theme/ThemeProvider";

export const metadata: Metadata = {
  title: {
    default: "ExtensionLab — Test your browser extensions.",
    template: "%s · ExtensionLab",
  },
  description:
    "Inspect, validate and understand your browser extension before you ship it.",
  icons: {
    icon: "/icons/favicon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F5F5F7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

const themeScript = `
(function () {
  try {
    var mode = localStorage.getItem("extensionlab:theme") || "system";
    var accent = localStorage.getItem("extensionlab:accent") || "blue";
    var dark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (dark) document.documentElement.classList.add("dark");
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    var accents = {
      blue: { hex: dark ? "#0A84FF" : "#0071E3", hover: dark ? "#2B96FF" : "#0077ED", soft: dark ? "rgba(10,132,255,0.16)" : "rgba(0,113,227,0.13)" },
      purple: { hex: "#8944AB", hover: "#8E4FB0", soft: "rgba(137,68,171,0.14)" },
      pink: { hex: "#D83684", hover: "#DB4C90", soft: "rgba(216,54,132,0.14)" },
      red: { hex: "#E0322F", hover: "#E44945", soft: "rgba(224,50,47,0.14)" },
      orange: { hex: "#E97900", hover: "#F08314", soft: "rgba(233,121,0,0.15)" },
      green: { hex: "#288C46", hover: "#329E50", soft: "rgba(40,140,70,0.14)" },
      teal: { hex: "#168C8C", hover: "#1CA3A3", soft: "rgba(22,140,140,0.14)" }
    };
    var a = accents[accent] || accents.blue;
    var root = document.documentElement;
    root.style.setProperty("--accent", a.hex);
    root.style.setProperty("--accent-hover", a.hover);
    root.style.setProperty("--accent-soft", a.soft);
    root.style.setProperty("--accent-foreground", "#FFFFFF");
  } catch (e) {}
})();
`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Per-request CSP nonce issued by middleware.ts; required for the inline
  // theme bootstrap under the strict script-src policy.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen antialiased">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
