import type { Metadata } from "next";
import { AccountSettings } from "@/components/workspace/AccountSettings";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <div>
      <p className="eyebrow">Workspace</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        Manage account, security, preferences and data.
      </p>
      <div className="mt-6">
        <AccountSettings />
      </div>
    </div>
  );
}
