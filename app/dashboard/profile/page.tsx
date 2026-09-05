import type { Metadata } from "next";
import { AccountSettings } from "@/components/workspace/AccountSettings";

export const metadata: Metadata = { title: "Profile" };

export default function ProfilePage() {
  return (
    <div>
      <p className="eyebrow">Workspace</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">Profile</h1>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        Your account identity and security preferences.
      </p>
      <div className="mt-6">
        <AccountSettings />
      </div>
    </div>
  );
}
