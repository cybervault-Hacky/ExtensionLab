"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { orgFetch, Panel } from "./ui";

export function NewOrganizationForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await orgFetch("/api/organizations", { method: "POST", body: JSON.stringify({ name, ...(slug ? { slug } : {}) }) });
    setBusy(false);
    if (!result.ok || !result.data) {
      setError(result.error ?? "Could not create the organization.");
      return;
    }
    const organization = result.data.organization as { id?: string } | undefined;
    if (organization?.id) {
      await orgFetch("/api/organizations/switch", { method: "POST", body: JSON.stringify({ organizationId: organization.id }) });
    }
    router.push("/dashboard/organization");
    router.refresh();
  };

  return (
    <Panel title="Create an organization" description="Organizations add teams, shared packages, API keys, webhooks and enterprise reporting on top of your personal workspace — which keeps working unchanged.">
      <form onSubmit={submit} className="space-y-3 max-w-md">
        <label className="block text-sm font-medium" htmlFor="org-name">
          Name
          <input
            id="org-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            minLength={2}
            maxLength={80}
            placeholder="Acme Extensions"
            className="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm font-medium" htmlFor="org-slug">
          Slug <span className="text-[var(--text-secondary)]">(optional, a–z, 0–9, hyphens)</span>
          <input
            id="org-slug"
            value={slug}
            onChange={(event) => setSlug(event.target.value.toLowerCase())}
            pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
            placeholder="acme-extensions"
            className="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
          />
        </label>
        {error ? <p className="text-sm text-rose-600">{error}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {busy ? "Creating…" : "Create organization"}
        </button>
      </form>
    </Panel>
  );
}
