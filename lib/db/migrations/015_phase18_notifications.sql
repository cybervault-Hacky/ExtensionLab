-- Phase 18: Notification layer — thin integration on existing event/action architecture.
-- Every record originates from a real, authorized event. No demo data inserted.

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN (
    'FOLLOWED','POST_LIKED','POST_COMMENTED','COMMENT_REPLIED','MENTIONED',
    'EXTENSION_UPDATED','EXTENSION_PUBLISHED','VERSION_RELEASED',
    'TEST_COMPLETED','TEST_FAILED','REGRESSION_DETECTED',
    'CI_COMPLETED','CI_FAILED','CI_REGRESSION',
    'REPORT_CREATED','REPORT_SHARED','REPORT_UPDATED',
    'ORG_INVITATION','ORG_ROLE_CHANGED','ORG_MEMBER_REMOVED'
  )),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('user','post','comment','extension','test_run','ci_run','report','organization')),
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  data_json TEXT NOT NULL DEFAULT '{}',
  read_at INTEGER,
  dedupe_key TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_unread ON notifications(recipient_user_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(dedupe_key, recipient_user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type, recipient_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  social_follow INTEGER NOT NULL DEFAULT 1,
  social_like INTEGER NOT NULL DEFAULT 0,
  social_comment INTEGER NOT NULL DEFAULT 1,
  social_reply INTEGER NOT NULL DEFAULT 1,
  social_mention INTEGER NOT NULL DEFAULT 1,
  extension_updated INTEGER NOT NULL DEFAULT 1,
  extension_released INTEGER NOT NULL DEFAULT 0,
  test_completed INTEGER NOT NULL DEFAULT 0,
  test_failed INTEGER NOT NULL DEFAULT 1,
  ci_failed INTEGER NOT NULL DEFAULT 1,
  ci_regression INTEGER NOT NULL DEFAULT 1,
  report_updated INTEGER NOT NULL DEFAULT 0,
  organization_invitation INTEGER NOT NULL DEFAULT 1,
  organization_role_changed INTEGER NOT NULL DEFAULT 1,
  organization_member_removed INTEGER NOT NULL DEFAULT 1,
  email_enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
