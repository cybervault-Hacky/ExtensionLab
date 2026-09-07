import Link from "next/link";

export default function NotificationsPage() {
  return (
    <div className="max-w-3xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
        <Link href="/api/v1/notifications/read-all" className="text-sm underline" onClick={async (e) => { e.preventDefault(); await fetch("/api/v1/notifications/read-all", { method: "POST", headers: { "Content-Type":"application/json" } }); window.location.reload(); }}>Mark all read</Link>
      </div>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <p className="text-sm text-[var(--text-secondary)]">Notifications are created from real events: follows, likes, comments, replies, mentions, extension releases, test results, CI results, and organization events.</p>
        <p className="mt-2 text-xs text-[var(--text-secondary)]">Private content never generates notifications for unauthorized users. Blocked users are suppressed.</p>
      </div>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] p-5 text-sm text-[var(--text-secondary)]">
        Use the API endpoints or refresh this page to load real notifications. Fresh production database starts with 0 notifications.
      </div>
    </div>
  );
}
