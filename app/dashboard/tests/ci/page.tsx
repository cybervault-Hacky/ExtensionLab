import Link from "next/link";

export default function CiDashboardPage() {
  return (
    <div className="max-w-3xl space-y-8 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">CI Runs</h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          ExtensionLab CI executions triggered from GitHub Actions. Metadata is bounded and safe.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] p-5">
          <h2 className="text-sm font-semibold">Setup Wizard</h2>
          <p className="mt-2 text-xs text-[var(--text-secondary)]">Select project, test, create API key, and copy workflow.</p>
          <Link href="/dashboard/tests/ci/setup" className="mt-3 inline-block text-sm underline">Go to setup</Link>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] p-5">
          <h2 className="text-sm font-semibold">Configuration</h2>
          <p className="mt-2 text-xs text-[var(--text-secondary)]">Validate .extensionlab.yml without running tests.</p>
          <span className="mt-3 inline-block text-xs text-[var(--status-success)]">Validate command available</span>
        </div>
      </div>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <h2 className="text-sm font-semibold">Recent CI metadata fields (bounded)</h2>
        <ul className="mt-2 space-y-1 text-xs text-[var(--text-secondary)] list-disc ml-4">
          <li>provider (github)</li>
          <li>repository (owner/repo)</li>
          <li>commitSha (abbreviated)</li>
          <li>branch (main / feature/…)</li>
          <li>workflow / workflowRunId</li>
          <li>pullRequestNumber (validated)</li>
        </ul>
      </div>
    </div>
  );
}
