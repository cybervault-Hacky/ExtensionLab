"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Logo } from "@/components/layout/Logo";

export function SignupForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const response = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "Account creation could not be completed.");
        return;
      }
      router.replace("/dashboard");
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
      <h1 className="mt-8 text-3xl font-semibold tracking-tight">Create your workspace</h1>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        Start analyzing, testing and reporting on browser extensions.
      </p>
      <form onSubmit={(event) => void submit(event)} className="mt-8 space-y-4">
        <label className="block">
          <span className="mb-2 block text-sm font-medium">Name</span>
          <input
            type="text"
            autoComplete="name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="min-h-[48px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
        </label>
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
          <span className="mb-2 block text-sm font-medium">Password</span>
          <input
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="min-h-[48px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <span className="mt-1.5 block text-xs text-[var(--text-secondary)]">At least 8 characters.</span>
        </label>
        {error ? (
          <p role="alert" className="rounded-xl border border-[var(--status-error)] bg-[var(--status-error-soft)] p-3 text-sm">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="accent" fullWidth loading={loading}>
          Create Account
        </Button>
        <p className="text-center text-sm text-[var(--text-secondary)]">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-[var(--accent)] hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
