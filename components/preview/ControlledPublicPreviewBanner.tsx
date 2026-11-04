export function ControlledPublicPreviewBanner() {
  return (
    <aside
      aria-label="Controlled public preview notice"
      className="border-b border-amber-500/30 bg-amber-50 px-4 py-2.5 text-center text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100"
    >
      <strong>Controlled public preview.</strong>{" "}
      Local, in-browser package inspection is available. Accounts, persistent uploads, APIs, AI assistance, payments, and browser testing are not configured on this deployment.
    </aside>
  );
}
