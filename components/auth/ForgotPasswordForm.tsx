"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Logo } from "@/components/layout/Logo";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setLoading(true);
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "The request could not be completed.");
        return;
      }
      setMessage("If an account exists for this email, instructions will be sent.");
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
      <h1 className="mt-8 text-3xl font-semibold tracking-tight">Reset your password</h1>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        Enter your account email and we will send reset instructions.
      </p>
      <form onSubmit={(event) => void submit(event)} className="mt-8 space-y-4">
        <label className="block">
          <span className="mb-2 block text-sm font-medium">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="min-h-[48px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm outline-none focus:border-[var(--accent)]"
          />
        </label>
        {message ? (
          <p role="status" className="rounded-xl border border-[var(--status-success)] bg-[var(--status-success-soft)] p-3 text-sm">
            {message}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-xl border border-[var(--status-error)] bg-[var(--status-error-soft)] p-3 text-sm">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="accent" fullWidth loading={loading}>
          Send Reset Instructions
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
