import type { Metadata } from "next";
import { ReportDetail } from "@/components/workspace/ReportDetail";

export const metadata: Metadata = { title: "Report" };
export const dynamic = "force-dynamic";

export default async function ReportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ReportDetail reportId={id} />;
}
