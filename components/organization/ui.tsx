"use client";

import { useCallback, useEffect, useState } from "react";

/** Shared helpers for the organization dashboard panels (client side). */

export interface ApiResult {
  ok: boolean;
  status: number;
  data: Record<string, unknown> | null;
  error: string | null;
}

export async function orgFetch(input: string, init?: RequestInit): Promise<ApiResult> {
  try {
    const response = await fetch(input, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const error = data && typeof data.error === "object" && data.error !== null
      ? String((data.error as { message?: unknown }).message ?? "Request failed")
      : null;
    return { ok: response.ok, status: response.status, data, error };
  } catch {
    return { ok: false, status: 0, data: null, error: "Network error." };
  }
}

export function useOrgData<T>(url: string | null): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    orgFetch(url).then((result) => {
      if (cancelled) return;
      if (result.ok && result.data) setData(result.data as T);
      else setError(result.error ?? "Failed to load.");
    });
    return () => {
      cancelled = true;
    };
  }, [url, tick]);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { data, error, reload };
}

export function Panel({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <h2 className="text-base font-semibold text-[var(--text-primary)]">{title}</h2>
      {description ? <p className="mt-1 text-sm text-[var(--text-secondary)]">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="mt-2 text-sm text-rose-600">{error}</p>;
}

export function formatWhen(value: number | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}
