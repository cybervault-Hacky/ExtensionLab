import { requireOrgPage } from "@/lib/organizations/page-guard";
import { getOrganizationEntitlements, seatUsage } from "@/lib/organizations/entitlements";
import { getOrganizationView } from "@/lib/organizations/service";
import { ExportsPanel } from "@/components/organization/ExportsPanel";

export const dynamic = "force-dynamic";

const FEATURE_LABELS: Array<[keyof ReturnType<typeof getOrganizationEntitlements> & string, string]> = [
  ["apiAccess", "Public API"],
  ["webhooks", "Webhooks"],
  ["advancedAuditLogs", "Advanced audit logs"],
  ["sso", "SSO (OIDC/SAML)"],
  ["dataExport", "Data export"],
  ["highConcurrency", "High concurrency"],
  ["advancedBrowserMatrix", "Advanced browser matrix"],
  ["ciCd", "CI/CD quality gates"],
];

export default async function OrganizationBillingPage() {
  const { userId, organizationId } = await requireOrgPage("org:billing:manage");
  const organization = getOrganizationView({ userId }, organizationId);
  const seats = seatUsage(organizationId);
  const entitlements = getOrganizationEntitlements(organizationId);
  return (
    <div className="space-y-6 py-8">
      <header>
        <h1 className="text-2xl font-bold">Usage & billing</h1>
        <p className="text-sm text-[var(--text-secondary)]">
          Plan {organization?.planId.toUpperCase()} ({organization?.planStatus}) · seat changes are server-authoritative; when the billing provider cannot update seats automatically an operator applies them.
        </p>
      </header>
      <div className="grid gap-4 sm:grid-cols-4">
        {[
          { label: "Seats (max)", value: String(seats.seats) },
          { label: "Active", value: String(seats.activeMembers) },
          { label: "Invited", value: String(seats.openInvitations) },
          { label: "Org concurrency", value: String(entitlements.orgMaxConcurrency) },
        ].map((card) => (
          <div key={card.label} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">{card.label}</p>
            <p className="mt-1 text-xl font-bold">{card.value}</p>
          </div>
        ))}
      </div>
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <h2 className="text-base font-semibold">Entitlements</h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {FEATURE_LABELS.map(([key, label]) => {
            const enabled = Boolean(entitlements[key]);
            return (
              <li key={key} className="flex items-center justify-between rounded-xl border border-[var(--border)] px-3 py-2 text-sm">
                <span>{label}</span>
                <span className={enabled ? "text-emerald-600" : "text-[var(--text-secondary)]"}>{enabled ? "included" : "—"}</span>
              </li>
            );
          })}
        </ul>
      </section>
      <ExportsPanel organizationId={organizationId} />
    </div>
  );
}
