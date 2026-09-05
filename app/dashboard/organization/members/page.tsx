import { requireOrgPage } from "@/lib/organizations/page-guard";
import { MembersPanel } from "@/components/organization/MembersPanel";

export const dynamic = "force-dynamic";

export default async function OrganizationMembersPage() {
  const { organizationId, role } = await requireOrgPage("org:members:read");
  return (
    <div className="py-8">
      <h1 className="mb-6 text-2xl font-bold">Members</h1>
      <MembersPanel organizationId={organizationId} yourRole={role} />
    </div>
  );
}
