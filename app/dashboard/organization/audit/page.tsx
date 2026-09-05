import { requireOrgPage } from "@/lib/organizations/page-guard";
import { AuditPanel } from "@/components/organization/AuditPanel";

export const dynamic = "force-dynamic";

export default async function OrganizationAuditPage() {
  const { organizationId } = await requireOrgPage("org:audit:read");
  return (
    <div className="py-8">
      <h1 className="mb-6 text-2xl font-bold">Audit log</h1>
      <AuditPanel organizationId={organizationId} />
    </div>
  );
}
