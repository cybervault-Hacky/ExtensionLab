import Link from "next/link";

export const dynamic = "force-dynamic";

export default function DeveloperPage() {
  return (
    <div className="space-y-6 py-8">
      <header>
        <h1 className="text-2xl font-bold">Developer</h1>
        <p className="text-sm text-[var(--text-secondary)]">Public API, API keys, idempotency and webhooks — everything a pipeline or integration needs.</p>
      </header>
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { href: "/docs/api", label: "API reference", hint: "Auth, scopes, endpoints, errors, rate limits" },
          { href: "/dashboard/organization/api", label: "API keys", hint: "Create and revoke org keys" },
          { href: "/dashboard/organization/webhooks", label: "Webhooks", hint: "Signed event delivery" },
        ].map((card) => (
          <Link key={card.href} href={card.href} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 hover:bg-[var(--surface-secondary)]">
            <p className="text-sm font-semibold">{card.label}</p>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">{card.hint}</p>
          </Link>
        ))}
      </div>
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 text-sm text-[var(--text-secondary)]">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">Quick start</h2>
        <pre className="mt-3 overflow-x-auto rounded-xl bg-slate-950 p-4 text-xs text-slate-100">{`curl -X POST "$BASE_URL/api/v1/packages" \\
  -H "Authorization: Bearer $EXTENSIONLAB_API_KEY" \\
  -H "Idempotency-Key: build-42" \\
  -F "file=@extension.zip"`}</pre>
      </section>
    </div>
  );
}
