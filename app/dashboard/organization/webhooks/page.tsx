import { requireOrgPage } from "@/lib/organizations/page-guard";
import { WebhooksPanel } from "@/components/organization/WebhooksPanel";

export const dynamic = "force-dynamic";

export default async function OrganizationWebhooksPage() {
  const { organizationId } = await requireOrgPage("org:webhooks:manage");
  return (
    <div className="py-8">
      <h1 className="mb-6 text-2xl font-bold">Webhooks</h1>
      <WebhooksPanel organizationId={organizationId} />
    </div>
  );
}
