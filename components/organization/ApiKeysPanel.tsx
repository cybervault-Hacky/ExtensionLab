"use client";

import { useState } from "react";
import { ErrorText, Panel, formatWhen, orgFetch, useOrgData } from "./ui";

interface ApiKeyView { id: string; name: string; prefix: string; scopes: string[]; createdAt: number; expiresAt: number | null; revokedAt: number | null; lastUsedAt: number | null }
interface KeysData { keys: ApiKeyView[] }

const ALL_SCOPES = [
  "packages:read", "packages:write",
  "analysis:read",
  "tests:read", "tests:write",
  "reports:read", "reports:write",
  "browser-matrix:read", "browser-matrix:write",
  "webhooks:read", "webhooks:write",
  "organization:read",
];

export function ApiKeysPanel({ organizationId }: { organizationId: string }) {
  const { data, error, reload } = useOrgData<KeysData>(`/api/organizations/${organizationId}/api-keys`);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["packages:read", "analysis:read", "tests:read"]);
  const [days, setDays] = useState(365);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setActionError(null);
    setSecret(null);
    const result = await orgFetch(`/api/organizations/${organizationId}/api-keys`, {
      method: "POST",
      body: JSON.stringify({ name, scopes, expiresInDays: days }),
    });
    setBusy(false);
    if (!result.ok || !result.data) {
      setActionError(result.error ?? "Could not create the key.");
      return;
    }
    setName("");
    setSecret(String((result.data as { key?: string }).key ?? ""));
    reload();
  };

  return (
    <div className="space-y-6">
      <Panel title="Create an API key" description="Keys are shown once and stored hashed. Pick the least privilege that works; keys never bypass plan or organization limits.">
        <form onSubmit={create} className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm font-medium">
              Name
              <input required value={name} onChange={(event) => setName(event.target.value)} maxLength={80} className="mt-1 block w-56 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm" placeholder="CI pipeline" />
            </label>
            <label className="text-sm font-medium">
              Expires (days)
              <input type="number" min={1} max={730} value={days} onChange={(event) => setDays(Number(event.target.value))} className="mt-1 block w-28 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm" />
            </label>
            <button type="submit" disabled={busy} className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">{busy ? "Creating…" : "Create key"}</button>
          </div>
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">Scopes</legend>
            {ALL_SCOPES.map((scope) => (
              <label key={scope} className={`cursor-pointer rounded-full border px-3 py-1 text-xs ${scopes.includes(scope) ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--text-secondary)]"}`}>
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={scopes.includes(scope)}
                  onChange={(event) => setScopes((current) => (event.target.checked ? [...current, scope] : current.filter((item) => item !== scope)))}
                />
                {scope}
              </label>
            ))}
          </fieldset>
        </form>
        {secret ? (
          <p className="mt-3 break-all rounded-xl bg-amber-50 p-3 text-xs text-amber-800">
            Copy this key now — it will not be shown again: <code>{secret}</code>
          </p>
        ) : null}
        <ErrorText error={actionError} />
      </Panel>
      <Panel title="API keys">
        <ul className="divide-y divide-[var(--border)]">
          {(data?.keys ?? []).map((key) => (
            <li key={key.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
              <div>
                <p className="font-medium">{key.name} <span className="ml-2 font-mono text-xs text-[var(--text-secondary)]">{key.prefix}…</span></p>
                <p className="text-xs text-[var(--text-secondary)]">
                  scopes: {key.scopes.join(", ")} · expires {formatWhen(key.expiresAt)} · last used {formatWhen(key.lastUsedAt)}
                </p>
              </div>
              {key.revokedAt ? (
                <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs text-rose-600">revoked</span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    const result = await orgFetch(`/api/organizations/${organizationId}/api-keys/${key.id}`, { method: "DELETE" });
                    setBusy(false);
                    if (result.ok) reload();
                    else setActionError(result.error ?? "Could not revoke.");
                  }}
                  className="rounded-lg border border-rose-200 px-2 py-1 text-xs text-rose-600 disabled:opacity-60"
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
          {(data?.keys ?? []).length === 0 ? <li className="py-3 text-sm text-[var(--text-secondary)]">No API keys yet.</li> : null}
        </ul>
        <ErrorText error={error} />
      </Panel>
    </div>
  );
}
