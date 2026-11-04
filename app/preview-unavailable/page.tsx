import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Unavailable in public preview",
  robots: { index: false, follow: false },
};

/**
 * Destination for infrastructure-dependent routes while the controlled public
 * preview is enabled. It is intentionally a normal page rather than a mocked
 * workspace, so no unavailable capability can appear functional.
 */
export default function PreviewUnavailablePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl items-center px-6 py-16">
      <section className="w-full rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm sm:p-10">
        <p className="eyebrow">Controlled public preview</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">This capability is not configured for the preview.</h1>
        <p className="mt-4 text-[var(--text-secondary)]">
          ExtensionLab has not enabled persistent accounts, cloud uploads, API access, AI assistance, automated browser testing, or payments on this public preview. No request was accepted and no result was generated.
        </p>
        <p className="mt-3 text-sm text-[var(--text-secondary)]">
          You can still use the local, in-browser package inspection workflow from the home page.
        </p>
        <Link
          href="/"
          className="mt-7 inline-flex min-h-11 items-center rounded-xl bg-[var(--accent)] px-4 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          Return to ExtensionLab
        </Link>
      </section>
    </main>
  );
}
