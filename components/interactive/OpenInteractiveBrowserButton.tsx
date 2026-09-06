"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Globe } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PaywallNotice, paywallFromError, type PaywallInfo } from "@/components/billing/PaywallNotice";

/**
 * "Open Interactive Browser" entry point (Phase 11).
 *
 * Creates a session bound to the exact package version and navigates to the
 * workspace. The same package version is used when launched from a report or
 * run context — the server resolves the binding, never the client.
 */
export function OpenInteractiveBrowserButton({
  packageId,
  label = "Open Interactive Browser",
  variant = "accent",
  size = "sm",
  initialUrl,
}: {
  packageId: string;
  label?: string;
  variant?: "primary" | "secondary" | "ghost" | "accent";
  size?: "sm" | "md" | "lg";
  initialUrl?: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<PaywallInfo | null>(null);

  const launch = async () => {
    setLoading(true);
    setError(null);
    setPaywall(null);
    try {
      const createResponse = await fetch("/api/browser-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packageId, ...(initialUrl ? { initialUrl } : {}) }),
      });
      const created = await createResponse.json().catch(() => null);
      if (!createResponse.ok) {
        const wall = paywallFromError(created);
        if (wall) setPaywall(wall);
        throw new Error(created?.error?.message ?? "The browser session could not be created.");
      }
      const sessionId = created?.session?.id as string | undefined;
      if (!sessionId) throw new Error("The browser session could not be created.");

      const startResponse = await fetch(`/api/browser-sessions/${sessionId}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!startResponse.ok) {
        const body = await startResponse.json().catch(() => null);
        const wall = paywallFromError(body);
        if (wall) setPaywall(wall);
        throw new Error(body?.error?.message ?? "The browser session could not be started.");
      }
      router.push(`/dashboard/browser/${sessionId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The browser session could not be started.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button variant={variant} size={size} onClick={launch} loading={loading}>
        <Globe className="h-4 w-4" aria-hidden="true" />
        {label}
      </Button>
      {paywall ? <PaywallNotice info={paywall} /> : null}
      {error && !paywall ? <p className="text-sm text-[var(--status-error)]">{error}</p> : null}
    </div>
  );
}
