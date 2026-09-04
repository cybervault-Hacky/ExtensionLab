import type { Metadata } from "next";
import { TestRunBrowser } from "@/components/tester/TestRunBrowser";

export const metadata: Metadata = { title: "Automated Test Report" };
export const dynamic = "force-dynamic";

export default async function AutomatedTestReportPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return <TestRunBrowser runId={runId} />;
}
