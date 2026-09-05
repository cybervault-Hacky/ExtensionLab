import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { restoreUser, SESSION_COOKIE } from "@/lib/auth/session";
import { getEffectivePlan } from "@/lib/billing/entitlements";
import { AppShell, type AppShellUser } from "@/components/workspace/AppShell";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value ?? "";
  const user = restoreUser(token);
  if (!user) {
    redirect(`/login?next=%2Fdashboard`);
  }
  const effective = getEffectivePlan(user.id);
  const viewUser: AppShellUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    planName: effective.plan.name,
    planState:
      effective.state === "past_due" || effective.state === "past_due_grace" || effective.state === "cancel_scheduled"
        ? "attention"
        : effective.paid
          ? "paid"
          : "free",
  };
  return <AppShell user={viewUser}>{children}</AppShell>;
}
