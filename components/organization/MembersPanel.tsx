"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ErrorText, Panel, formatWhen, orgFetch, useOrgData } from "./ui";

interface MemberView { userId: string; email: string; name: string; role: string; joinedAt: number }
interface InvitationView { id: string; email: string; role: string; status: string; expiresAt: number }
interface MembersData { members: MemberView[]; seats: { seats: number; activeMembers: number; openInvitations: number; available: number }; invitations: InvitationView[] }

const ROLES = ["viewer", "developer", "admin"] as const;

export function MembersPanel({ organizationId, yourRole }: { organizationId: string; yourRole: string }) {
  const router = useRouter();
  const { data, error, reload } = useOrgData<MembersData>(`/api/organizations/${organizationId}/members`);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("developer");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const canManage = yourRole === "owner" || yourRole === "admin";

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setActionError(null);
    setInviteUrl(null);
    const result = await orgFetch(`/api/organizations/${organizationId}/members`, { method: "POST", body: JSON.stringify({ email, role }) });
    setBusy(false);
    if (!result.ok || !result.data) {
      setActionError(result.error ?? "Could not send the invitation.");
      return;
    }
    setEmail("");
    setInviteUrl(String((result.data as { inviteUrl?: string }).inviteUrl ?? ""));
    reload();
  };

  const act = async (init: RequestInit, path = "") => {
    setBusy(true);
    setActionError(null);
    const result = await orgFetch(`/api/organizations/${organizationId}/members${path}`, init);
    setBusy(false);
    if (!result.ok) setActionError(result.error ?? "Action failed.");
    else reload();
  };

  return (
    <div className="space-y-6">
      {data ? (
        <Panel title="Seats" description="Active members and open invitations both consume seats.">
          <p className="text-sm text-[var(--text-secondary)]">
            {data.seats.activeMembers} active · {data.seats.openInvitations} invited · {data.seats.available} of {data.seats.seats} available
          </p>
        </Panel>
      ) : null}
      {canManage ? (
        <Panel title="Invite a member" description="The invitation link is shown once and expires. Tokens are stored hashed; resending rotates them.">
          <form onSubmit={invite} className="flex flex-wrap items-end gap-3">
            <label className="text-sm font-medium">
              Email
              <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1 block w-64 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm" placeholder="teammate@example.com" />
            </label>
            <label className="text-sm font-medium">
              Role
              <select value={role} onChange={(event) => setRole(event.target.value)} className="mt-1 block rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm">
                {ROLES.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={busy} className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
              {busy ? "Working…" : "Invite"}
            </button>
          </form>
          {inviteUrl ? (
            <p className="mt-3 break-all rounded-xl bg-amber-50 p-3 text-xs text-amber-800">
              One-time invite link (copy now — it will not be shown again): <code>{inviteUrl}</code>
            </p>
          ) : null}
          <ErrorText error={actionError} />
        </Panel>
      ) : null}
      <Panel title="Members">
        <ul className="divide-y divide-[var(--border)]">
          {(data?.members ?? []).map((member) => (
            <li key={member.userId} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
              <div>
                <p className="font-medium">{member.name || member.email}</p>
                <p className="text-xs text-[var(--text-secondary)]">{member.email} · joined {formatWhen(member.joinedAt)}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-[var(--surface-secondary)] px-2 py-0.5 text-xs uppercase tracking-wide">{member.role}</span>
                {canManage && member.role !== "owner" ? (
                  <select
                    aria-label={`Role for ${member.email}`}
                    value={member.role}
                    disabled={busy}
                    onChange={(event) => act({ method: "PATCH", body: JSON.stringify({ targetUserId: member.userId, role: event.target.value }) })}
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
                  >
                    {ROLES.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                ) : null}
                {canManage && member.role !== "owner" ? (
                  <button type="button" disabled={busy} onClick={() => act({ method: "DELETE" }, `?userId=${member.userId}`)} className="rounded-lg border border-rose-200 px-2 py-1 text-xs text-rose-600 disabled:opacity-60">
                    Remove
                  </button>
                ) : null}
                {yourRole === "owner" && member.role === "admin" ? (
                  <button type="button" disabled={busy} onClick={() => act({ method: "PATCH", body: JSON.stringify({ targetUserId: member.userId, transferOwnership: true }) })} className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs disabled:opacity-60">
                    Make owner
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        <ErrorText error={error} />
      </Panel>
      {canManage ? (
        <Panel title="Open invitations">
          <ul className="divide-y divide-[var(--border)]">
            {(data?.invitations ?? []).map((invitation) => (
              <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <div>
                  <p className="font-medium">{invitation.email}</p>
                  <p className="text-xs text-[var(--text-secondary)]">{invitation.role} · expires {formatWhen(invitation.expiresAt)}</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" disabled={busy} onClick={async () => { setBusy(true); const result = await orgFetch(`/api/organizations/${organizationId}/invitations/${invitation.id}`, { method: "POST" }); setBusy(false); if (result.ok && result.data) { setInviteUrl(String((result.data as { inviteUrl?: string }).inviteUrl ?? "")); } else setActionError(result.error ?? "Could not resend."); }} className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs disabled:opacity-60">
                    Resend
                  </button>
                  <button type="button" disabled={busy} onClick={async () => { setBusy(true); const result = await orgFetch(`/api/organizations/${organizationId}/invitations/${invitation.id}`, { method: "DELETE" }); setBusy(false); if (result.ok) reload(); else setActionError(result.error ?? "Could not revoke."); }} className="rounded-lg border border-rose-200 px-2 py-1 text-xs text-rose-600 disabled:opacity-60">
                    Revoke
                  </button>
                </div>
              </li>
            ))}
            {(data?.invitations ?? []).length === 0 ? <li className="py-3 text-sm text-[var(--text-secondary)]">No open invitations.</li> : null}
          </ul>
          <ErrorText error={actionError} />
        </Panel>
      ) : null}
      <Panel title="Leave organization" description="Owners must transfer ownership first.">
        <button
          type="button"
          disabled={busy || yourRole === "owner"}
          onClick={async () => {
            setBusy(true);
            const result = await orgFetch(`/api/organizations/${organizationId}/members`, { method: "DELETE" });
            setBusy(false);
            if (result.ok) {
              await orgFetch("/api/organizations/switch", { method: "POST", body: JSON.stringify({ organizationId: "personal" }) });
              router.push("/dashboard");
              router.refresh();
            } else setActionError(result.error ?? "Could not leave.");
          }}
          className="rounded-xl border border-rose-200 px-4 py-2 text-sm font-semibold text-rose-600 disabled:opacity-60"
        >
          Leave
        </button>
        <ErrorText error={actionError} />
      </Panel>
    </div>
  );
}
