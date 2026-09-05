"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Logo } from "@/components/layout/Logo";

export function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get("next") || "/dashboard";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "Sign in could not be completed.");
        return;
      }
      router.replace(next);
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
      <h1 className="mt-8 text-3xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        Sign in to your ExtensionLab workspace.
      </p>
      <form onSubmit={(event) => void submit(event)} className="mt-8 space-y-4">
        <label className="block">
          <span className="mb-2 block text-sm font-medium">Email</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="min-h-[48px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
        </label>
        <label className="block">
          <span className="mb-2 flex items-center justify-between text-sm font-medium">
            Password
          </span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="min-h-[48px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
        </label>
        {error ? (
          <p role="alert" className="rounded-xl border border-[var(--status-error)] bg-[var(--status-error-soft)] p-3 text-sm">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="accent" fullWidth loading={loading}>
          Sign In
        </Button>
        <div className="flex items-center justify-between text-sm">
          <Link href="/forgot-password" className="font-medium text-[var(--accent)] hover:underline">
            Forgot password?
          </Link>
          <Link href="/signup" className="font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
            Create account
          </Link>
        </div>
      </form>
    </div>
  );
}
