import { requireOrgPage } from "@/lib/organizations/page-guard";
import { getOrganizationView } from "@/lib/organizations/service";
import { OrgSettingsPanel } from "@/components/organization/OrgSettingsPanel";

export const dynamic = "force-dynamic";

export default async function OrganizationSettingsPage() {
  const { userId, organizationId, role } = await requireOrgPage("org:settings:manage");
  const organization = getOrganizationView({ userId }, organizationId);
  return (
    <div className="py-8">
      <h1 className="mb-2 text-2xl font-bold">Organization settings</h1>
      <p className="mb-6 text-sm text-[var(--text-secondary)]">Role: {role}. Deleting requires owner confirmation.</p>
      <OrgSettingsPanel organizationId={organizationId} name={organization?.name ?? ""} />
    </div>
  );
}
