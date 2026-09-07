import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q.length === 0 || q.length > 100) return NextResponse.json({ results: [] });
    const safeQ = q.replace(/[^a-zA-Z0-9_\-\s]/g, "").trim();
    if (safeQ.length === 0) return NextResponse.json({ results: [] });
    const { getDb } = await import("@/lib/db/client");
    const db = getDb();
    const term = `%${safeQ}%`;
    const users = db.prepare("SELECT user_id, username, display_name FROM user_profiles WHERE profile_visibility = 'public' AND (username LIKE ? OR display_name LIKE ?) LIMIT 10").all(term, term) as Array<{ user_id: string; username: string; display_name: string }>;
    const extensions = db.prepare("SELECT id, name, version FROM extensions WHERE name LIKE ? LIMIT 10").all(term) as Array<{ id: string; name: string; version: string }>;
    return NextResponse.json({ users, extensions });
  } catch (error) {
    return NextResponse.json({ error: "Search unavailable." }, { status: 500 });
  }
}
