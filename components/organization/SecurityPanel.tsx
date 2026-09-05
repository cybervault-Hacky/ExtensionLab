"use client";

import { useState } from "react";
import { ErrorText, Panel, orgFetch, useOrgData } from "./ui";

interface SsoView { protocol: "oidc" | "saml"; status: "configured" | "enforced" | null; config: Record<string, string>; enforcedDomains: string[] }
interface SsoData { sso: SsoView }
interface DomainsData { domains: Array<{ id: string; domain: string; verified: boolean }> }

export function SecurityPanel({ organizationId }: { organizationId: string }) {
  const { data, error, reload } = useOrgData<SsoData>(`/api/organizations/${organizationId}/sso`);
  const { data: domains, reload: reloadDomains } = useOrgData<DomainsData>(`/api/organizations/${organizationId}/domains`);
  const [protocol, setProtocol] = useState<"oidc" | "saml">("oidc");
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [entryPoint, setEntryPoint] = useState("");
  const [certificate, setCertificate] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [domain, setDomain] = useState("");
  const [txt, setTxt] = useState<{ name: string; value: string } | null>(null);

  const save = async (enforced: boolean) => {
    setBusy(true);
    setActionError(null);
    const config = protocol === "oidc"
      ? { issuer, authorizationEndpoint: `${issuer.replace(/\/$/, "")}/authorize`, tokenEndpoint: `${issuer.replace(/\/$/, "")}/token`, clientId, clientSecret }
      : { entryPoint, idpCertificate: certificate, audience: clientId };
    const result = await orgFetch(`/api/organizations/${organizationId}/sso`, {
      method: "PUT",
      body: JSON.stringify({ protocol, status: enforced ? "enforced" : "configured", config }),
    });
    setBusy(false);
    if (!result.ok) setActionError(result.error ?? "Could not save the SSO configuration.");
    else reload();
  };

  return (
    <div className="space-y-6">
      <Panel title="Verified domains" description="Verify ownership with a DNS TXT record. Verified domains can back SSO login routing.">
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setActionError(null);
            setTxt(null);
            const result = await orgFetch(`/api/organizations/${organizationId}/domains`, { method: "POST", body: JSON.stringify({ domain }) });
            setBusy(false);
            if (!result.ok || !result.data) {
              setActionError(result.error ?? "Could not add the domain.");
              return;
            }
            setDomain("");
            setTxt((result.data as { txtRecord?: { name: string; value: string } }).txtRecord ?? null);
            reloadDomains();
          }}
          className="flex flex-wrap items-end gap-3"
        >
          <label className="text-sm font-medium">
            Domain
            <input required value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="example.com" className="mt-1 block w-56 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm" />
          </label>
          <button type="submit" disabled={busy} className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">Add domain</button>
        </form>
        {txt ? (
          <p className="mt-3 break-all rounded-xl bg-amber-50 p-3 text-xs text-amber-800">
            Create this TXT record, then verify: <code>{txt.name} TXT &quot;{txt.value}&quot;</code>
          </p>
        ) : null}
        <ul className="mt-4 divide-y divide-[var(--border)]">
          {(domains?.domains ?? []).map((item) => (
            <li key={item.id} className="flex items-center justify-between py-2 text-sm">
              <span className="font-medium">{item.domain} {item.verified ? <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">verified</span> : null}</span>
              <span className="flex gap-2">
                {!item.verified ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      const result = await orgFetch(`/api/organizations/${organizationId}/domains?verify=${item.id}`, { method: "POST" });
                      setBusy(false);
                      if (result.ok && result.data && (result.data as { verified?: boolean }).verified) reloadDomains();
                      else setActionError("DNS check did not find the TXT record yet — it can take minutes to propagate.");
                    }}
                    className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs disabled:opacity-60"
                  >
                    Verify DNS
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    await orgFetch(`/api/organizations/${organizationId}/domains/${item.id}`, { method: "DELETE" });
                    setBusy(false);
                    reloadDomains();
                  }}
                  className="rounded-lg border border-rose-200 px-2 py-1 text-xs text-rose-600 disabled:opacity-60"
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
          {(domains?.domains ?? []).length === 0 ? <li className="py-2 text-sm text-[var(--text-secondary)]">No domains added.</li> : null}
        </ul>
        <ErrorText error={error ?? actionError} />
      </Panel>
      <Panel title="Single sign-on (SSO)" description="OIDC or SAML configuration layer. Assertion validation runs in the provider adapter at login; ExtensionLab never fabricates authentication. Enforced SSO applies to verified domains only.">
        <div className="flex gap-2">
          {(["oidc", "saml"] as const).map((option) => (
            <label key={option} className={`cursor-pointer rounded-full border px-3 py-1 text-xs ${protocol === option ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--text-secondary)]"}`}>
              <input type="radio" name="sso-protocol" className="sr-only" checked={protocol === option} onChange={() => setProtocol(option)} />
              {option.toUpperCase()}
            </label>
          ))}
          {data?.sso.status ? <span className="ml-2 rounded-full bg-[var(--surface-secondary)] px-2 py-0.5 text-xs">{data.sso.status}</span> : null}
        </div>
        {protocol === "oidc" ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium">Issuer URL<input value={issuer} onChange={(event) => setIssuer(event.target.value)} placeholder="https://idp.example.com" className="mt-1 block w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm" /></label>
            <label className="text-sm font-medium">Client ID<input value={clientId} onChange={(event) => setClientId(event.target.value)} className="mt-1 block w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm" /></label>
            <label className="text-sm font-medium sm:col-span-2">Client secret (write-only)<input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} className="mt-1 block w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm" /></label>
          </div>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium">IdP entry point<input value={entryPoint} onChange={(event) => setEntryPoint(event.target.value)} placeholder="https://idp.example.com/sso/saml" className="mt-1 block w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm" /></label>
            <label className="text-sm font-medium">Audience (entity ID)<input value={clientId} onChange={(event) => setClientId(event.target.value)} className="mt-1 block w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm" /></label>
            <label className="text-sm font-medium sm:col-span-2">IdP certificate (PEM)<textarea value={certificate} onChange={(event) => setCertificate(event.target.value)} rows={3} className="mt-1 block w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm" /></label>
          </div>
        )}
        <div className="mt-4 flex gap-2">
          <button type="button" disabled={busy} onClick={() => save(false)} className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold disabled:opacity-60">Save configuration</button>
          <button type="button" disabled={busy} onClick={() => save(true)} className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">Save & enforce</button>
        </div>
        {data?.sso.enforcedDomains.length ? (
          <p className="mt-3 text-xs text-[var(--text-secondary)]">Login routing active for: {data.sso.enforcedDomains.join(", ")}</p>
        ) : null}
        <ErrorText error={actionError} />
      </Panel>
    </div>
  );
}
