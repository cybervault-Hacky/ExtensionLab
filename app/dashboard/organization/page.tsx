import Link from "next/link";
import { requireOrgPage } from "@/lib/organizations/page-guard";
import { getOrganizationView } from "@/lib/organizations/service";
import { getOrganizationEntitlements, seatUsage } from "@/lib/organizations/entitlements";
import { countActiveJobsForOrganization } from "@/lib/db/repositories/jobs";

export const dynamic = "force-dynamic";

export default async function OrganizationOverviewPage() {
  const { userId, organizationId, role } = await requireOrgPage("org:read");
  const organization = getOrganizationView({ userId }, organizationId);
  if (!organization) {
    return <p className="py-8 text-sm">Organization not found.</p>;
  }
  const seats = seatUsage(organizationId);
  const entitlements = getOrganizationEntitlements(organizationId);
  const activeJobs = countActiveJobsForOrganization(organizationId);

  const cards = [
    { label: "Plan", value: organization.planId.toUpperCase(), hint: organization.planStatus },
    { label: "Seats", value: `${seats.activeMembers}/${seats.seats}`, hint: `${seats.openInvitations} invited` },
    { label: "Active jobs", value: String(activeJobs), hint: `max concurrency ${entitlements.orgMaxConcurrency}` },
    { label: "Your role", value: role, hint: role === "viewer" ? "read-only" : "full access per role" },
  ];

  return (
    <div className="space-y-6 py-8">
      <header>
        <h1 className="text-2xl font-bold">{organization.name}</h1>
        <p className="text-sm text-[var(--text-secondary)]">/{organization.slug} · created {new Date(organization.createdAt).toLocaleDateString()}</p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <div key={card.label} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">{card.label}</p>
            <p className="mt-1 text-xl font-bold">{card.value}</p>
            <p className="text-xs text-[var(--text-secondary)]">{card.hint}</p>
          </div>
        ))}
      </div>
      <nav className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Organization sections">
        {[
          { href: "/dashboard/organization/members", label: "Members & invitations" },
          { href: "/dashboard/organization/api", label: "API keys" },
          { href: "/dashboard/organization/webhooks", label: "Webhooks" },
          { href: "/dashboard/organization/audit", label: "Audit log" },
          { href: "/dashboard/organization/billing", label: "Usage, billing & exports" },
          { href: "/dashboard/organization/security", label: "Security & SSO" },
        ].map((item) => (
          <Link key={item.href} href={item.href} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm font-medium hover:bg-[var(--surface-secondary)]">
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
