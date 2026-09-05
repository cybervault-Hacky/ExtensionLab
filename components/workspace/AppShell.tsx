"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Activity,
  Building2,
  CreditCard,
  FileText,
  FolderOpen,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  ScrollText,
  Settings,
  User,
  Webhook,
  X,
} from "lucide-react";
import { Logo } from "@/components/layout/Logo";
import { Button } from "@/components/ui/Button";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { cn } from "@/lib/utils";

export interface AppShellWorkspace {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "developer" | "viewer";
}

export interface AppShellUser {
  id: string;
  email: string;
  name: string;
  /** Effective plan name resolved server-side (display only). */
  planName?: string;
  planState?: "free" | "paid" | "attention";
}

const ROLES = ["owner", "admin", "developer", "viewer"] as const;

const orgNavItems = [
  { label: "Organization", href: "/dashboard/organization", icon: Building2, roles: ROLES },
  { label: "Members", href: "/dashboard/organization/members", icon: Building2, roles: ["owner", "admin", "developer", "viewer"] as readonly string[] },
  { label: "API keys", href: "/dashboard/organization/api", icon: KeyRound, roles: ["owner", "admin"] as readonly string[] },
  { label: "Webhooks", href: "/dashboard/organization/webhooks", icon: Webhook, roles: ["owner", "admin"] as readonly string[] },
  { label: "Audit log", href: "/dashboard/organization/audit", icon: ScrollText, roles: ["owner", "admin"] as readonly string[] },
  { label: "Usage & billing", href: "/dashboard/organization/billing", icon: CreditCard, roles: ["owner", "admin"] as readonly string[] },
  { label: "Security & SSO", href: "/dashboard/organization/security", icon: Settings, roles: ["owner"] as readonly string[] },
  { label: "Settings", href: "/dashboard/organization/settings", icon: Settings, roles: ["owner", "admin"] as readonly string[] },
];

const navItems = [
  { label: "Overview", href: "/dashboard", icon: LayoutDashboard },
  { label: "Extensions", href: "/dashboard/extensions", icon: FolderOpen },
  { label: "Tests", href: "/dashboard/tests", icon: Activity },
  { label: "Reports", href: "/dashboard/reports", icon: FileText },
  { label: "Integrations", href: "/dashboard/integrations", icon: FileText },
  { label: "Developer", href: "/dashboard/developer", icon: LayoutDashboard },
  { label: "Billing", href: "/dashboard/billing", icon: CreditCard },
];

export function AppShell({
  user,
  workspace,
  workspaceOptions,
  children,
}: {
  user: AppShellUser;
  workspace: AppShellWorkspace | null;
  workspaceOptions: AppShellWorkspace[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);

  const switchWorkspace = async (organizationId: string) => {
    if ((workspace?.id ?? "personal") === organizationId) return;
    setSwitching(organizationId);
    try {
      const response = await fetch("/api/organizations/switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });
      if (response.ok) {
        router.push(organizationId === "personal" ? "/dashboard" : "/dashboard/organization");
        router.refresh();
      }
    } finally {
      setSwitching(null);
    }
  };

  const logout = async () => {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/login";
    }
  };

  const nav = (
    <nav aria-label="Workspace" className="space-y-1">
      {navItems.map((item) => {
        const Icon = item.icon;
        const active =
          pathname === item.href ||
          (item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`));
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setMobileOpen(false)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-[44px] items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors",
              active
                ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)]",
            )}
          >
            <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-4 pb-20 sm:px-6 lg:flex-row lg:px-8">
        <aside className="hidden w-60 shrink-0 lg:block">
          <div className="sticky top-8 space-y-8 pt-8">
            <Link href="/dashboard" aria-label="ExtensionLab dashboard">
              <Logo />
            </Link>
            <Button href="/dashboard/analyze" variant="accent" size="sm" fullWidth>
              New Analysis
            </Button>
            <WorkspaceSwitcher
              workspace={workspace}
              options={workspaceOptions}
              switching={switching}
              onSwitch={switchWorkspace}
            />
            {nav}
            {workspace ? (
              <div className="space-y-3">
                <p className="px-3 text-[11px] font-semibold uppercase tracking-widest text-[var(--text-secondary)]">
                  {workspace.name}
                </p>
                <nav aria-label="Organization" className="space-y-1">
                  {orgNavItems
                    .filter((item) => item.roles.includes(workspace.role))
                    .map((item) => {
                      const Icon = item.icon;
                      const active =
                        pathname === item.href || (item.href !== "/dashboard/organization" && pathname.startsWith(`${item.href}/`));
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "flex min-h-[44px] items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors",
                            active
                              ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                              : "text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)]",
                          )}
                        >
                          <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
                          {item.label}
                        </Link>
                      );
                    })}
                </nav>
              </div>
            ) : null}
            <div className="border-t border-[var(--border)] pt-6">
              <div className="px-2">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-semibold">{user.name || "Account"}</p>
                  {user.planName ? <PlanBadge name={user.planName} state={user.planState} /> : null}
                </div>
                <p className="truncate text-xs text-[var(--text-secondary)]">{user.email}</p>
              </div>
              <div className="mt-4 space-y-1">
                <Link
                  href="/dashboard/settings"
                  className={cn(
                    "flex min-h-[40px] items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors",
                    pathname === "/dashboard/settings"
                      ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)]",
                  )}
                >
                  <Settings className="h-[18px] w-[18px]" aria-hidden="true" />
                  Settings
                </Link>
                <Link
                  href="/dashboard/profile"
                  className={cn(
                    "flex min-h-[40px] items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors",
                    pathname === "/dashboard/profile"
                      ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)]",
                  )}
                >
                  <User className="h-[18px] w-[18px]" aria-hidden="true" />
                  Profile
                </Link>
                <button
                  type="button"
                  onClick={logout}
                  disabled={loggingOut}
                  className="flex min-h-[40px] w-full items-center gap-3 rounded-xl px-3 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)] disabled:opacity-60"
                >
                  <LogOut className="h-[18px] w-[18px]" aria-hidden="true" />
                  {loggingOut ? "Signing out…" : "Log out"}
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="flex min-h-[40px] w-full items-center gap-3 rounded-xl px-3 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)]"
            >
              <Settings className="h-[18px] w-[18px]" aria-hidden="true" />
              Appearance
            </button>
          </div>
        </aside>

        <div className="min-w-0 flex-1 lg:pt-8">
          <header className="sticky top-0 z-30 -mx-4 mb-6 flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg)]/90 px-4 py-3 backdrop-blur-xl sm:-mx-6 sm:px-6 lg:hidden">
            <Link href="/dashboard" aria-label="ExtensionLab dashboard">
              <Logo compact />
            </Link>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Appearance"
                onClick={() => setSettingsOpen(true)}
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)]"
              >
                <Settings className="h-5 w-5" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={mobileOpen ? "Close menu" : "Open menu"}
                aria-expanded={mobileOpen}
                onClick={() => setMobileOpen((current) => !current)}
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-[var(--text-primary)] hover:bg-[var(--surface-secondary)]"
              >
                {mobileOpen ? (
                  <X className="h-5 w-5" aria-hidden="true" />
                ) : (
                  <Menu className="h-5 w-5" aria-hidden="true" />
                )}
              </button>
            </div>
          </header>

          {mobileOpen ? (
            <div className="mb-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-soft lg:hidden">
              <Button href="/dashboard/analyze" variant="accent" size="sm" fullWidth onClick={() => setMobileOpen(false)}>
                New Analysis
              </Button>
              <div className="mt-4">{nav}</div>
              <div className="mt-4 flex items-center justify-between border-t border-[var(--border)] pt-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold">{user.name || "Account"}</p>
                    {user.planName ? <PlanBadge name={user.planName} state={user.planState} /> : null}
                  </div>
                  <p className="truncate text-xs text-[var(--text-secondary)]">{user.email}</p>
                </div>
                <Button variant="secondary" size="sm" onClick={() => void logout()} loading={loggingOut}>
                  <LogOut className="h-4 w-4" aria-hidden="true" />
                  Log out
                </Button>
              </div>
            </div>
          ) : null}

          {children}
        </div>
      </div>
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

function PlanBadge({ name, state }: { name: string; state?: "free" | "paid" | "attention" }) {
  return (
    <Link
      href="/dashboard/billing"
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-4",
        state === "paid"
          ? "border-transparent bg-[var(--accent-soft)] text-[var(--accent)]"
          : state === "attention"
            ? "border-[var(--status-warning)] text-[var(--status-warning)]"
            : "border-[var(--border)] text-[var(--text-secondary)]",
      )}
      aria-label={`Plan: ${name}. Open billing`}
    >
      {name}
    </Link>
  );
}

function WorkspaceSwitcher({
  workspace,
  options,
  switching,
  onSwitch,
}: {
  workspace: AppShellWorkspace | null;
  options: AppShellWorkspace[];
  switching: string | null;
  onSwitch: (organizationId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex w-full min-h-[44px] items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-medium transition-colors hover:bg-[var(--surface-secondary)]"
      >
        <span className="flex items-center gap-2 truncate">
          {workspace ? <Building2 className="h-4 w-4 text-[var(--accent)]" aria-hidden="true" /> : <User className="h-4 w-4" aria-hidden="true" />}
          <span className="truncate">{workspace ? workspace.name : "Personal workspace"}</span>
        </span>
        <span className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">{workspace ? workspace.role : "personal"}</span>
      </button>
      {open ? (
        <ul role="listbox" className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-lg">
          <li role="option" aria-selected={workspace === null}>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onSwitch("personal");
              }}
              disabled={switching !== null}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--surface-secondary)] disabled:opacity-60"
            >
              <User className="h-4 w-4" aria-hidden="true" /> Personal workspace
            </button>
          </li>
          {options.map((option) => (
            <li key={option.id} role="option" aria-selected={workspace?.id === option.id}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onSwitch(option.id);
                }}
                disabled={switching !== null}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--surface-secondary)] disabled:opacity-60"
              >
                <span className="flex items-center gap-2 truncate">
                  <Building2 className="h-4 w-4 text-[var(--accent)]" aria-hidden="true" />
                  <span className="truncate">{option.name}</span>
                </span>
                <span className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">{option.role}</span>
              </button>
            </li>
          ))}
          <li className="border-t border-[var(--border)]">
            <Link href="/dashboard/organization/new" className="block px-3 py-2 text-sm text-[var(--accent)] hover:bg-[var(--surface-secondary)]">
              + Create organization…
            </Link>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
