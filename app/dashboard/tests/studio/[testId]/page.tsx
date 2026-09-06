import type { Metadata } from "next";
import { SavedTestDetail } from "@/components/studio/SavedTestDetail";

export const metadata: Metadata = { title: "Saved Test" };

/**
 * /dashboard/tests/studio/[testId] — saved-test detail (Phase 15 §74):
 * definition, immutable version history, deterministic analytics, recent
 * runs, baseline and CI hints.
 */
export default async function SavedTestPage({ params }: { params: Promise<{ testId: string }> }) {
  const { testId } = await params;
  return <SavedTestDetail testId={testId} />;
}
