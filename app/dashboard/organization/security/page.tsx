import { requireOrgPage } from "@/lib/organizations/page-guard";
import { SecurityPanel } from "@/components/organization/SecurityPanel";

export const dynamic = "force-dynamic";

export default async function OrganizationSecurityPage() {
  const { organizationId } = await requireOrgPage("org:sso:manage");
  return (
    <div className="py-8">
      <h1 className="mb-6 text-2xl font-bold">Security & SSO</h1>
      <SecurityPanel organizationId={organizationId} />
    </div>
  );
}
