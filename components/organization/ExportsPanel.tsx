"use client";

import { useState } from "react";
import { ErrorText, Panel, formatWhen, orgFetch, useOrgData } from "./ui";

interface ExportView { id: string; status: string; createdAt: number; expiresAt: number; size: number | null }
interface ExportsData { exports: ExportView[] }

export function ExportsPanel({ organizationId }: { organizationId: string }) {
  const { data, error, reload } = useOrgData<ExportsData>(`/api/organizations/${organizationId}/exports`);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  return (
    <Panel title="Data export" description="Asynchronous export of organization data (metadata — package bytes are re-uploaded, not shipped). Artifacts expire automatically; downloads are audited.">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setActionError(null);
          const result = await orgFetch(`/api/organizations/${organizationId}/exports`, { method: "POST" });
          setBusy(false);
          if (result.ok) reload();
          else setActionError(result.error ?? "Could not start the export.");
        }}
        className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      >
        {busy ? "Starting…" : "Request export"}
      </button>
      <ul className="mt-4 divide-y divide-[var(--border)]">
        {(data?.exports ?? []).map((item) => (
          <li key={item.id} className="flex items-center justify-between gap-2 py-2 text-sm">
            <span>
              {formatWhen(item.createdAt)} · <span className={item.status === "completed" ? "text-emerald-600" : item.status === "failed" ? "text-rose-600" : "text-amber-600"}>{item.status}</span>
              {item.size ? <span className="text-xs text-[var(--text-secondary)]"> · {(item.size / 1024).toFixed(1)} KB</span> : null}
            </span>
            {item.status === "completed" ? (
              <a href={`/api/organizations/${organizationId}/exports?download=${item.id}`} className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs">
                Download
              </a>
            ) : null}
          </li>
        ))}
        {(data?.exports ?? []).length === 0 ? <li className="py-2 text-sm text-[var(--text-secondary)]">No exports requested yet.</li> : null}
      </ul>
      <ErrorText error={actionError ?? error} />
    </Panel>
  );
}
