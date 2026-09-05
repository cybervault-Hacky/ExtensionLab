import type { Metadata } from "next";
import { MatrixRunView } from "@/components/tester/MatrixRunView";

export const metadata: Metadata = { title: "Browser Matrix Run" };
export const dynamic = "force-dynamic";

export default async function MatrixRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <MatrixRunView matrixRunId={runId} />;
}
