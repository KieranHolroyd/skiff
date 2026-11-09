-- First-class groups for the native user-pool identity engine (IAM.md I27, §11.2). Additive only.
--
-- Groups are the pool's own, not platform IAM groups: a pool visitor's membership is keyed to
-- `user_pool_users`, and the names travel as the `groups` claim in an access token and userinfo.
-- Yoal Access rules can therefore match a `userPool` matcher with `groups`.
--
-- The name is unique within a pool (case-insensitively) so an admin cannot create two groups that a
-- claim consumer would read as one. Membership is a plain join row; `pool_id` is repeated there so
-- a pool purge or a GDPR user delete is one predicate rather than a join.
--
-- The generated migrations bundle (`packages/db/src/migrations.ts`) is regenerated separately by
-- `scripts/generate-migrations.ts`; this slice does not rewrite it.

CREATE TABLE IF NOT EXISTS user_pool_groups (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS user_pool_groups_pool_name_idx
  ON user_pool_groups (pool_id, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS user_pool_groups_pool_idx
  ON user_pool_groups (pool_id, created_at);

CREATE TABLE IF NOT EXISTS user_pool_group_members (
  pool_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS user_pool_group_members_user_idx
  ON user_pool_group_members (pool_id, user_id);
CREATE INDEX IF NOT EXISTS user_pool_group_members_group_idx
  ON user_pool_group_members (group_id, created_at);
