"use client";

import { useState } from "react";
import { ErrorText, Panel, formatWhen, orgFetch, useOrgData } from "./ui";

interface WebhookView { id: string; url: string; events: string[]; active: boolean; createdAt: number }
interface WebhooksData { webhooks: WebhookView[] }
interface DeliveriesData { deliveries: Array<{ id: string; eventType: string; status: string; attempts: number; lastStatusCode: number | null; lastError: string | null; nextAttemptAt: number | null; createdAt: number }> }

const EVENT_OPTIONS = ["package.created", "analysis.completed", "analysis.failed", "test_run.created", "test_run.completed", "test_run.failed", "browser_matrix.created", "browser_matrix.completed", "browser_matrix.failed", "regression.detected", "report.created", "member.joined", "export.completed", "export.failed"];

export function WebhooksPanel({ organizationId }: { organizationId: string }) {
  const { data, error, reload } = useOrgData<WebhooksData>(`/api/organizations/${organizationId}/webhooks`);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["package.created", "test_run.completed", "browser_matrix.completed", "regression.detected"]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const { data: deliveries } = useOrgData<DeliveriesData>(selected ? `/api/organizations/${organizationId}/webhooks/${selected}` : null);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setActionError(null);
    setSecret(null);
    const result = await orgFetch(`/api/organizations/${organizationId}/webhooks`, { method: "POST", body: JSON.stringify({ url, events }) });
    setBusy(false);
    if (!result.ok || !result.data) {
      setActionError(result.error ?? "Could not create the webhook.");
      return;
    }
    setUrl("");
    setSecret(String((result.data as { secret?: string }).secret ?? ""));
    reload();
  };

  return (
    <div className="space-y-6">
      <Panel title="Register a webhook" description="HTTPS only. Destinations pointing at private networks or cloud metadata are rejected. Secrets are shown once and used to sign X-ExtensionLab-Signature.">
        <form onSubmit={create} className="space-y-3">
          <label className="block text-sm font-medium">
            HTTPS URL
            <input required type="url" pattern="https://.*" value={url} onChange={(event) => setUrl(event.target.value)} className="mt-1 block w-full max-w-lg rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm" placeholder="https://ci.example.com/hooks/extensionlab" />
          </label>
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">Events</legend>
            {EVENT_OPTIONS.map((event) => (
              <label key={event} className={`cursor-pointer rounded-full border px-3 py-1 text-xs ${events.includes(event) ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--text-secondary)]"}`}>
                <input type="checkbox" className="sr-only" checked={events.includes(event)} onChange={(change) => setEvents((current) => (change.target.checked ? [...current, event] : current.filter((item) => item !== event)))} />
                {event}
              </label>
            ))}
          </fieldset>
          <button type="submit" disabled={busy} className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">{busy ? "Saving…" : "Add webhook"}</button>
        </form>
        {secret ? (
          <p className="mt-3 break-all rounded-xl bg-amber-50 p-3 text-xs text-amber-800">
            Signing secret (shown once): <code>{secret}</code>
          </p>
        ) : null}
        <ErrorText error={actionError} />
      </Panel>
      <Panel title="Webhooks" description="Click a webhook to inspect its delivery history.">
        <ul className="divide-y divide-[var(--border)]">
          {(data?.webhooks ?? []).map((webhook) => (
            <li key={webhook.id} className="py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button type="button" onClick={() => setSelected(selected === webhook.id ? null : webhook.id)} className="font-medium text-left break-all">
                  {webhook.url}
                </button>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${webhook.active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{webhook.active ? "active" : "paused"}</span>
                  <button type="button" disabled={busy} onClick={async () => { setBusy(true); const result = await orgFetch(`/api/organizations/${organizationId}/webhooks/${webhook.id}`, { method: "PATCH", body: JSON.stringify({ active: !webhook.active }) }); setBusy(false); if (result.ok) reload(); }} className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs disabled:opacity-60">
                    {webhook.active ? "Pause" : "Resume"}
                  </button>
                  <button type="button" disabled={busy} onClick={async () => { setBusy(true); const result = await orgFetch(`/api/organizations/${organizationId}/webhooks/${webhook.id}`, { method: "DELETE" }); setBusy(false); if (result.ok) reload(); }} className="rounded-lg border border-rose-200 px-2 py-1 text-xs text-rose-600 disabled:opacity-60">
                    Delete
                  </button>
                </div>
              </div>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">{webhook.events.join(", ")}</p>
              {selected === webhook.id ? (
                <ul className="mt-2 space-y-1 rounded-xl bg-[var(--surface-secondary)] p-3 text-xs">
                  {(deliveries?.deliveries ?? []).slice(0, 10).map((delivery) => (
                    <li key={delivery.id} className="flex items-center justify-between gap-2">
                      <span className="font-mono">{delivery.eventType}</span>
                      <span className={delivery.status === "succeeded" ? "text-emerald-600" : delivery.status === "dead_letter" ? "text-rose-600" : "text-amber-600"}>
                        {delivery.status} · {delivery.attempts} attempt(s){delivery.lastStatusCode ? ` · HTTP ${delivery.lastStatusCode}` : ""}
                      </span>
                    </li>
                  ))}
                  {(deliveries?.deliveries ?? []).length === 0 ? <li className="text-[var(--text-secondary)]">No deliveries yet.</li> : null}
                </ul>
              ) : null}
            </li>
          ))}
          {(data?.webhooks ?? []).length === 0 ? <li className="py-3 text-sm text-[var(--text-secondary)]">No webhooks registered.</li> : null}
        </ul>
        <ErrorText error={error} />
      </Panel>
    </div>
  );
}
