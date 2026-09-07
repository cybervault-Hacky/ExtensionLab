export default function CiSetupPage() {
  return (
    <div className="max-w-2xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">CI Setup</h1>
      <ol className="list-decimal ml-5 space-y-2 text-sm text-[var(--text-secondary)]">
        <li>Select project</li>
        <li>Select saved test</li>
        <li>Create a dedicated CI API key (tests:write, packages:write)</li>
        <li>Add <code>EXTENSIONLAB_API_KEY</code> to repository secrets</li>
        <li>Copy workflow snippet (placeholders only — never inject real keys)</li>
        <li>Run workflow and verify connection (safe call, no browser test started)</li>
      </ol>
      <p className="text-xs text-[var(--text-secondary)]">No secrets are displayed after creation if existing security policy prevents it.</p>
    </div>
  );
}
