"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, LogOut, ShieldCheck, Trash2, UserRound, Database } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

interface MeResponse {
  user: { id: string; email: string; name: string; createdAt: number };
  plan: { name: string; analysisLimit: number; testRunLimit: number };
  usage: { analysisUsed: number; testRunUsed: number };
  activeSessions: Array<{ id: string; createdAt: number; lastActiveAt: number; userAgent: string | null; ipAddress: string | null }>;
}

export function AccountSettings() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/me");
    if (!response.ok) {
      setError("Unable to load account details.");
      return;
    }
    const data = (await response.json()) as MeResponse;
    setMe(data);
    setName(data.user.name);
    setEmail(data.user.email);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const response = await fetch("/api/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          currentPassword,
          newPassword: newPassword || undefined,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "Account settings could not be updated.");
        return;
      }
      setMessage(newPassword ? "Profile updated and other sessions signed out." : "Profile updated.");
      setCurrentPassword("");
      setNewPassword("");
      void load();
    } finally {
      setBusy(false);
    }
  };

  const logoutAll = async () => {
    setBusy(true);
    try {
      await fetch("/api/sessions", { method: "POST" });
      setMessage("Other sessions have been signed out.");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async () => {
    if (deleteConfirm !== "DELETE") {
      setError("Type DELETE to confirm.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/me", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "Account deletion failed.");
        return;
      }
      router.replace("/signup");
    } finally {
      setBusy(false);
    }
  };

  if (!me) {
    return (
      <div className="space-y-4">
        <div className="card h-28 animate-pulse" />
        <div className="card h-40 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-center gap-2">
          <UserRound className="h-5 w-5 text-[var(--text-secondary)]" aria-hidden="true" />
          <h2 className="text-base font-semibold tracking-tight">Account</h2>
        </div>
        <form onSubmit={(event) => void saveProfile(event)} className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-2 block text-sm font-medium">Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="min-h-[48px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm outline-none focus:border-[var(--accent)]"
            />
          </label>
          <label className="block">
            <span className="mb-2 block text-sm font-medium">Email</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="min-h-[48px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm outline-none focus:border-[var(--accent)]"
            />
          </label>
          <label className="block">
            <span className="mb-2 block text-sm font-medium">Current password</span>
            <input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              className="min-h-[48px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm outline-none focus:border-[var(--accent)]"
            />
          </label>
          <label className="block">
            <span className="mb-2 block text-sm font-medium">New password</span>
            <input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder="Leave blank to keep"
              className="min-h-[48px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm outline-none focus:border-[var(--accent)]"
            />
          </label>
          <div className="sm:col-span-2">
            <Button type="submit" variant="accent" loading={busy}>
              Save Changes
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-[var(--text-secondary)]" aria-hidden="true" />
          <h2 className="text-base font-semibold tracking-tight">Security</h2>
        </div>
        <div className="mt-5 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium">Active sessions</p>
              <p className="text-xs text-[var(--text-secondary)]">
                {me.activeSessions.length} active session(s). Use the appearance panel for theme preferences.
              </p>
            </div>
            <Button variant="secondary" size="sm" loading={busy} onClick={() => void logoutAll()}>
              <LogOut className="h-4 w-4" aria-hidden="true" />
              Log out all other sessions
            </Button>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {me.activeSessions.map((session) => (
              <div key={session.id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-sm font-medium">{deviceLabel(session.userAgent)}</p>
                  <p className="text-xs text-[var(--text-secondary)]">
                    {session.ipAddress ?? "Unknown IP"} · Last active {relativeTime(session.lastActiveAt)}
                  </p>
                </div>
                <Badge tone="info">Active</Badge>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5 text-[var(--text-secondary)]" aria-hidden="true" />
          <h2 className="text-base font-semibold tracking-tight">Usage</h2>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4">
          <UsageStat label="Analyses" used={me.usage.analysisUsed} limit={me.plan.analysisLimit} />
          <UsageStat label="Test runs" used={me.usage.testRunUsed} limit={me.plan.testRunLimit} />
        </div>
      </Card>

      <Card>
        <div className="flex items-center gap-2">
          <Trash2 className="h-5 w-5 text-[var(--status-error)]" aria-hidden="true" />
          <h2 className="text-base font-semibold tracking-tight">Data</h2>
        </div>
        <p className="mt-3 text-sm text-[var(--text-secondary)]">
          Deleting your account removes your projects, analysis snapshots, test runs, reports and shared links.
        </p>
        {!showDelete ? (
          <Button variant="secondary" size="sm" className="mt-4" onClick={() => setShowDelete(true)}>
            Delete Account
          </Button>
        ) : (
          <div className="mt-4 space-y-3 rounded-xl border border-[var(--status-error)] bg-[var(--status-error-soft)] p-4">
            <p className="text-sm font-semibold">Delete your ExtensionLab account?</p>
            <p className="text-sm text-[var(--text-secondary)]">
              This will remove your projects, reports, test history and shared links. This action cannot be undone.
            </p>
            <input
              value={deleteConfirm}
              onChange={(event) => setDeleteConfirm(event.target.value)}
              placeholder="Type DELETE"
              className="min-h-[46px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm"
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => setShowDelete(false)}>
                Cancel
              </Button>
              <Button variant="secondary" size="sm" loading={busy} onClick={() => void deleteAccount()}>
                Delete Account
              </Button>
            </div>
          </div>
        )}
      </Card>

      {message ? (
        <p role="status" className="rounded-xl border border-[var(--status-success)] bg-[var(--status-success-soft)] p-3 text-sm">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-xl border border-[var(--status-error)] bg-[var(--status-error-soft)] p-3 text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function UsageStat({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;
  return (
    <div>
      <p className="text-sm text-[var(--text-secondary)]">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{used}<span className="text-base font-normal text-[var(--text-secondary)]"> / {limit}</span></p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-secondary)]">
        <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function deviceLabel(agent: string | null): string {
  if (!agent) return "Unknown device";
  if (/android/i.test(agent)) return "Android / Chrome";
  if (/iPhone|iPad|iOS/i.test(agent)) return "iOS / Mobile";
  if (/Firefox/i.test(agent)) return "Firefox";
  return "Chrome / Desktop";
}

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
