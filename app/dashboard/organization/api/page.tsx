import Link from "next/link";
import { requireOrgPage } from "@/lib/organizations/page-guard";
import { ApiKeysPanel } from "@/components/organization/ApiKeysPanel";

export const dynamic = "force-dynamic";

export default async function OrganizationApiKeysPage() {
  const { organizationId } = await requireOrgPage("org:api-keys:manage");
  return (
    <div className="py-8">
      <h1 className="mb-2 text-2xl font-bold">API keys</h1>
      <p className="mb-6 text-sm text-[var(--text-secondary)]">
        Programmatic access to the versioned public API. See the <Link href="/docs/api" className="text-[var(--accent)] underline">API documentation</Link> for endpoints, scopes, rate limits and idempotency.
      </p>
      <ApiKeysPanel organizationId={organizationId} />
    </div>
  );
}
