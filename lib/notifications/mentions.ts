/** Phase 18 — Safe mention resolution. Only existing users; no enumeration. */
import { getProfileByUsername } from "@/lib/db/repositories/community";
import { notifyMentioned } from "./service";

export function parseMentions(text: string): string[] {
  const mentions: string[] = [];
  const regex = /@([a-z][a-z0-9_]*)/gi;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const handle = m[1].toLowerCase();
    if (!mentions.includes(handle)) mentions.push(handle);
  }
  return mentions;
}

export function notifyMentionsFromPost(postId: string, authorUserId: string, content: string): void {
  const handles = parseMentions(content);
  for (const handle of handles) {
    const profile = getProfileByUsername(handle);
    if (!profile || profile.user_id === authorUserId) continue;
    notifyMentioned(profile.user_id, authorUserId, postId);
  }
}
