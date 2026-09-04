"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Activity,
  FileText,
  FolderOpen,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  User,
  X,
} from "lucide-react";
import { Logo } from "@/components/layout/Logo";
import { Button } from "@/components/ui/Button";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { cn } from "@/lib/utils";

export interface AppShellUser {
  id: string;
  email: string;
  name: string;
}

const navItems = [
  { label: "Overview", href: "/dashboard", icon: LayoutDashboard },
  { label: "Extensions", href: "/dashboard/extensions", icon: FolderOpen },
  { label: "Tests", href: "/dashboard/tests", icon: Activity },
  { label: "Reports", href: "/dashboard/reports", icon: FileText },
];

export function AppShell({
  user,
  children,
}: {
  user: AppShellUser;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

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
            {nav}
            <div className="border-t border-[var(--border)] pt-6">
              <div className="px-2">
                <p className="text-sm font-semibold">{user.name || "Account"}</p>
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
                <div>
                  <p className="text-sm font-semibold">{user.name || "Account"}</p>
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
