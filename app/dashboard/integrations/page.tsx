import Link from "next/link";

export const dynamic = "force-dynamic";

export default function IntegrationsPage() {
  return (
    <div className="space-y-6 py-8">
      <header>
        <h1 className="text-2xl font-bold">Integrations</h1>
        <p className="text-sm text-[var(--text-secondary)]">CI/CD pipelines, webhooks and the public API. No proprietary runner required — everything is plain HTTPS and JSON.</p>
      </header>
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <h2 className="text-base font-semibold">CI/CD flow</h2>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-[var(--text-secondary)]">
          <li>Upload the extension ZIP (<code>POST /api/v1/packages</code>, <code>Idempotency-Key</code> recommended)</li>
          <li>Static analysis runs inline; the response carries the health score and issue count</li>
          <li>Run the test suite (<code>POST /api/v1/test-runs</code>) or a browser matrix (pass several <code>browsers</code>)</li>
          <li>Poll the run/matrix until terminal; read the report (<code>GET /api/v1/reports/:id</code>)</li>
          <li>Evaluate the organization quality gates (<code>GET /api/v1/browser-matrices/:id</code> returns the server-computed PASS|FAIL|NOT EVALUATED verdict)</li>
          <li>Gates are deterministic and server-evaluated; infrastructure failures are never reported as PASS</li>
        </ol>
        <p className="mt-3 text-sm">
          Ready-to-adapt GitHub Actions, GitLab CI, Jenkins and generic HTTP examples live in the{" "}
          <Link href="/docs/api" className="text-[var(--accent)] underline">API documentation</Link>.
        </p>
      </section>
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <h2 className="text-base font-semibold">Webhooks</h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          Register HTTPS endpoints in your organization workspace to receive signed events (package created, analyses, runs, matrices, regressions, reports, exports). Retries use exponential backoff with a dead-letter state.
        </p>
      </section>
    </div>
  );
}
