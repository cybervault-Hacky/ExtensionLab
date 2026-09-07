-- Phase 17: Developer profiles, social community, and public discovery.
-- All new entities only; existing users, organizations, extensions, sessions,
-- audit, packages, tests, CI and billing remain authoritative.
-- No demo data is inserted.

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  website TEXT,
  developer_title TEXT,
  location TEXT,
  profile_visibility TEXT NOT NULL DEFAULT 'public' CHECK (profile_visibility IN ('public','private')),
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_username ON user_profiles(username);
CREATE INDEX IF NOT EXISTS idx_user_profiles_visibility ON user_profiles(profile_visibility, created_at DESC);

CREATE TABLE IF NOT EXISTS organization_profiles (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '',
  public_visibility TEXT NOT NULL DEFAULT 'public' CHECK (public_visibility IN ('public','private')),
  website TEXT,
  location TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_org_profiles_visibility ON organization_profiles(public_visibility);

CREATE TABLE IF NOT EXISTS developer_follows (
  follower_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followed_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (follower_user_id, followed_user_id),
  CHECK (follower_user_id != followed_user_id)
);

CREATE INDEX IF NOT EXISTS idx_developer_follows_followed ON developer_follows(followed_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_developer_follows_follower ON developer_follows(follower_user_id);

CREATE TABLE IF NOT EXISTS social_posts (
  id TEXT PRIMARY KEY,
  author_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_text TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  attachment_extension_id TEXT REFERENCES extensions(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_author ON social_posts(author_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_visibility ON social_posts(visibility, created_at DESC);

CREATE TABLE IF NOT EXISTS post_likes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_post_likes_post ON post_likes(post_id);

CREATE TABLE IF NOT EXISTS post_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  author_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_text TEXT NOT NULL DEFAULT '',
  parent_comment_id TEXT REFERENCES post_comments(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden','removed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_post_comments_post ON post_comments(post_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_comments_parent ON post_comments(parent_comment_id);

CREATE TABLE IF NOT EXISTS saved_items (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('extension','post','developer')),
  item_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_type, item_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_items_user ON saved_items(user_id, item_type, created_at DESC);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','private')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_collections_owner ON collections(owner_user_id, visibility, updated_at DESC);

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('extension','post','developer')),
  item_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (collection_id, item_type, item_id)
);

CREATE INDEX IF NOT EXISTS idx_collection_items_col ON collection_items(collection_id);

CREATE TABLE IF NOT EXISTS content_reports (
  id TEXT PRIMARY KEY,
  reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('user','extension','post','comment')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('spam','abuse','impersonation','malicious_content','copyright_concern','other')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden','removed','under_review')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_target ON content_reports(target_type, target_id, status);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON content_reports(reporter_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  CHECK (blocker_user_id != blocked_user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_user_id);

CREATE TABLE IF NOT EXISTS public_activity (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('extension_published','extension_released','post_published','profile_updated','organization_joined')),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_extension_id TEXT REFERENCES extensions(id) ON DELETE SET NULL,
  target_post_id TEXT REFERENCES social_posts(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_actor ON public_activity(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_extension ON public_activity(target_extension_id, created_at DESC);
