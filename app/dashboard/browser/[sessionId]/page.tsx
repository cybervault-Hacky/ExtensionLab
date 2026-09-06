import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { restoreUser, SESSION_COOKIE } from "@/lib/auth/session";
import { isSafeId } from "@/lib/auth/validation";
import { AppError } from "@/lib/observability/errors";
import { toSessionView } from "@/lib/interactive/service";
import { getOwnedSession } from "@/lib/db/repositories/browser-sessions";
import { BrowserWorkspace } from "@/components/interactive/BrowserWorkspace";

export const metadata: Metadata = { title: "Interactive Browser" };
export const dynamic = "force-dynamic";

/**
 * Interactive browser workspace (Phase 11). Server-side ownership check: a
 * session that does not belong to the caller does not exist (404).
 */
export default async function InteractiveBrowserPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  if (!isSafeId(sessionId)) notFound();
  const cookieStore = await cookies();
  const user = restoreUser(cookieStore.get(SESSION_COOKIE)?.value ?? "");
  if (!user) redirect("/login");

  let session;
  try {
    const row = getOwnedSession(user.id, sessionId);
    if (!row) notFound();
    session = toSessionView(row);
  } catch (error) {
    if (error instanceof AppError) notFound();
    throw error;
  }

  return <BrowserWorkspace initialSession={session} />;
}
