"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Logo } from "@/components/layout/Logo";

export function ResetPasswordForm() {
  const router = useRouter();
  const search = useSearchParams();
  const token = search.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "The reset link could not be completed.");
        return;
      }
      setDone(true);
      setTimeout(() => router.replace("/login"), 900);
    } catch {
      setError("We could not reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md">
      <Link href="/" className="inline-flex items-center gap-2" aria-label="ExtensionLab home">
        <Logo />
      </Link>
      <h1 className="mt-8 text-3xl font-semibold tracking-tight">Choose a new password</h1>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        Use at least 8 characters.
      </p>
      {!token ? (
        <p role="alert" className="mt-6 rounded-xl border border-[var(--status-error)] bg-[var(--status-error-soft)] p-3 text-sm">
          The reset link is invalid or missing. Request a new reset link.
        </p>
      ) : null}
      <form onSubmit={(event) => void submit(event)} className="mt-8 space-y-4">
        <label className="block">
          <span className="mb-2 block text-sm font-medium">New password</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            disabled={!token || done}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="min-h-[48px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm outline-none focus:border-[var(--accent)] disabled:opacity-60"
          />
        </label>
        <label className="block">
          <span className="mb-2 block text-sm font-medium">Confirm password</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            disabled={!token || done}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            className="min-h-[48px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm outline-none focus:border-[var(--accent)] disabled:opacity-60"
          />
        </label>
        {done ? (
          <p role="status" className="rounded-xl border border-[var(--status-success)] bg-[var(--status-success-soft)] p-3 text-sm">
            Password updated. Redirecting to sign in…
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-xl border border-[var(--status-error)] bg-[var(--status-error-soft)] p-3 text-sm">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="accent" fullWidth loading={loading} disabled={!token || done}>
          Update Password
        </Button>
        <p className="text-center text-sm">
          <Link href="/login" className="font-medium text-[var(--accent)] hover:underline">
            Back to sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
