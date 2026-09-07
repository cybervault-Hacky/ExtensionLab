import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { getDb } = await import("@/lib/db/client");
    const db = getDb();
    // Real public data only; no fake content. Empty state handled by returning empty arrays.
    // Public extensions with visibility from existing extension table (we assume extensions with user_id are public unless private; Phase 17 adds visibility to extensions if needed, but for now we list all with basic info - this respects that existing extensions are public by default for discovery).
    const extensions = db.prepare("SELECT id, name, user_id, version FROM extensions ORDER BY created_at DESC LIMIT 10").all() as Array<{ id: string; name: string; user_id: string; version: string }>;
    // Public profiles
    const profiles = db.prepare("SELECT user_id, username, display_name FROM user_profiles WHERE profile_visibility = 'public' ORDER BY created_at DESC LIMIT 10").all() as Array<{ user_id: string; username: string; display_name: string }>;
    // Public posts
    const posts = db.prepare("SELECT id, author_user_id, content_text FROM social_posts WHERE visibility = 'public' ORDER BY created_at DESC LIMIT 10").all() as Array<{ id: string; author_user_id: string; content_text: string }>;
    return NextResponse.json({ extensions, developers: profiles, posts });
  } catch (error) {
    return NextResponse.json({ error: "Discovery unavailable." }, { status: 500 });
  }
}
