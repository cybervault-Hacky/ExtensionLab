import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import "./globals.css";
import { ControlledPublicPreviewBanner } from "@/components/preview/ControlledPublicPreviewBanner";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { isControlledPublicPreview } from "@/lib/preview";

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

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading request headers keeps this layout dynamically rendered. Next.js
  // then consumes the nonce-bearing CSP request header injected by middleware
  // and gives the same nonce to its own scripts. We never render that nonce as
  // a React prop, so it cannot differ between server and client hydration.
  const requestHeaders = await headers();
  void requestHeaders.get("content-security-policy");
  const controlledPreview = isControlledPublicPreview();
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        {controlledPreview ? <ControlledPublicPreviewBanner /> : null}
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
