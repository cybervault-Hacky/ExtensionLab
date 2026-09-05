"use client";

import { useState } from "react";
import { ErrorText, Panel, formatWhen, orgFetch, useOrgData } from "./ui";

interface AuditEvent { id: string; action: string; actorUserId: string | null; actorApiKeyId: string | null; resourceType: string | null; resourceId: string | null; success: boolean; requestId: string | null; ip: string | null; createdAt: number; metadata: Record<string, unknown> | null }
interface AuditData { items: AuditEvent[]; total: number; page: number; limit: number; actions: string[] }

export function AuditPanel({ organizationId }: { organizationId: string }) {
  const [action, setAction] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const params = new URLSearchParams();
  if (action) params.set("action", action);
  if (search) params.set("search", search);
  if (from) params.set("from", String(new Date(from).getTime()));
  if (to) params.set("to", String(new Date(to).getTime() + 86399999));
  params.set("page", String(page));
  const { data, error } = useOrgData<AuditData>(`/api/organizations/${organizationId}/audit?${params.toString()}`);

  const download = async () => {
    const result = await orgFetch(`/api/organizations/${organizationId}/audit?${params.toString()}&limit=100`);
    if (result.data) {
      const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `extensionlab-audit-${organizationId}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    }
  };

  return (
    <Panel title="Audit log" description="Immutable, redacted record of security-relevant actions. Secrets, source and headers are never captured.">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm font-medium">
          Action
          <select value={action} onChange={(event) => { setAction(event.target.value); setPage(1); }} className="mt-1 block rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm">
            <option value="">All actions</option>
            {(data?.actions ?? []).map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium">
          Search
          <input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="resource id…" className="mt-1 block w-44 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm" />
        </label>
        <label className="text-sm font-medium">
          From
          <input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} className="mt-1 block rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm" />
        </label>
        <label className="text-sm font-medium">
          To
          <input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} className="mt-1 block rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm" />
        </label>
        <button type="button" onClick={download} className="rounded-xl border border-[var(--border)] px-3 py-2 text-sm">Export view</button>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">
            <tr>
              <th className="py-2 pr-4">When</th>
              <th className="py-2 pr-4">Action</th>
              <th className="py-2 pr-4">Actor</th>
              <th className="py-2 pr-4">Resource</th>
              <th className="py-2 pr-4">Result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {(data?.items ?? []).map((event) => (
              <tr key={event.id}>
                <td className="py-2 pr-4 whitespace-nowrap">{formatWhen(event.createdAt)}</td>
                <td className="py-2 pr-4 font-mono text-xs">{event.action}</td>
                <td className="py-2 pr-4 text-xs">{event.actorApiKeyId ? "api-key" : (event.actorUserId ?? "system").slice(0, 12)}</td>
                <td className="py-2 pr-4 text-xs">{event.resourceType ? `${event.resourceType}:${(event.resourceId ?? "").slice(0, 14)}` : "—"}</td>
                <td className={`py-2 pr-4 text-xs ${event.success ? "text-emerald-600" : "text-rose-600"}`}>{event.success ? "ok" : "failed"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center justify-between text-sm">
        <span className="text-[var(--text-secondary)]">{data ? `${data.total} event(s)` : "…"}</span>
        <div className="flex gap-2">
          <button type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-lg border border-[var(--border)] px-3 py-1 disabled:opacity-50">Previous</button>
          <button type="button" disabled={!data || page * (data.limit ?? 25) >= data.total} onClick={() => setPage((value) => value + 1)} className="rounded-lg border border-[var(--border)] px-3 py-1 disabled:opacity-50">Next</button>
        </div>
      </div>
      <ErrorText error={error} />
    </Panel>
  );
}
