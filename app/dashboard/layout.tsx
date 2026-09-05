import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { restoreUser, SESSION_COOKIE } from "@/lib/auth/session";
import { AppShell, type AppShellUser } from "@/components/workspace/AppShell";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value ?? "";
  const user = restoreUser(token);
  if (!user) {
    redirect(`/login?next=%2Fdashboard`);
  }
  const viewUser: AppShellUser = {
    id: user.id,
    email: user.email,
    name: user.name,
  };
  return <AppShell user={viewUser}>{children}</AppShell>;
}
