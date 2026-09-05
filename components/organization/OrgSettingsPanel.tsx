"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ErrorText, Panel, orgFetch } from "./ui";

export function OrgSettingsPanel({ organizationId, name }: { organizationId: string; name: string }) {
  const router = useRouter();
  const [rename, setRename] = useState(name);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <Panel title="Organization profile">
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            const result = await orgFetch(`/api/organizations/${organizationId}`, { method: "PATCH", body: JSON.stringify({ name: rename }) });
            setBusy(false);
            if (result.ok) router.refresh();
            else setActionError(result.error ?? "Rename failed.");
          }}
          className="flex flex-wrap items-end gap-3"
        >
          <label className="text-sm font-medium">
            Name
            <input required minLength={2} maxLength={80} value={rename} onChange={(event) => setRename(event.target.value)} className="mt-1 block w-64 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm" />
          </label>
          <button type="submit" disabled={busy} className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">Save</button>
        </form>
        <ErrorText error={actionError} />
      </Panel>
      <Panel title="Delete organization" description="Irreversible. Type the organization name to confirm. Audit events are retained per policy.">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm font-medium">
            Confirm name
            <input value={confirm} onChange={(event) => setConfirm(event.target.value)} className="mt-1 block w-64 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm" />
          </label>
          <button
            type="button"
            disabled={busy || confirm !== name}
            onClick={async () => {
              setBusy(true);
              const result = await orgFetch(`/api/organizations/${organizationId}`, { method: "DELETE" });
              setBusy(false);
              if (result.ok) {
                await orgFetch("/api/organizations/switch", { method: "POST", body: JSON.stringify({ organizationId: "personal" }) });
                router.push("/dashboard");
                router.refresh();
              } else setActionError(result.error ?? "Delete failed.");
            }}
            className="rounded-xl border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-600 disabled:opacity-50"
          >
            Delete permanently
          </button>
        </div>
        <ErrorText error={actionError} />
      </Panel>
    </div>
  );
}
