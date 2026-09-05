import { NewOrganizationForm } from "@/components/organization/NewOrganizationForm";

export const dynamic = "force-dynamic";

export default function NewOrganizationPage() {
  return (
    <div className="mx-auto w-full max-w-2xl py-8">
      <h1 className="text-2xl font-bold">New organization</h1>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">You will become the owner. Personal workspaces are unaffected.</p>
      <div className="mt-6">
        <NewOrganizationForm />
      </div>
    </div>
  );
}
