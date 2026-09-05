import type { Metadata } from "next";
import { RegressionView } from "@/components/tester/RegressionView";

export const metadata: Metadata = { title: "Regression Comparison" };
export const dynamic = "force-dynamic";

export default async function RegressionPage({
  searchParams,
}: {
  searchParams: Promise<{ comparisonId?: string }>;
}) {
  const { comparisonId } = await searchParams;
  if (!comparisonId) {
    return (
      <div className="card card-pad text-sm text-[var(--text-secondary)]">
        Open a regression comparison from a finished browser matrix run, or designate a baseline and
        use “Compare with baseline”.
      </div>
    );
  }
  return <RegressionView comparisonId={comparisonId} />;
}
