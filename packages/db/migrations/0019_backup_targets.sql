-- Backup targets (plan 05, docs/BACKUPS.md). Additive only.
-- A target is where platform and managed-data backups are written: a local directory or any
-- S3-compatible bucket. `org_id` NULL is the platform default; an org row overrides it. Credentials
-- are sealed with the org data key and never selected by a view. Multiple targets may exist per
-- org; the oldest is the default and a caller may name one explicitly.

CREATE TABLE IF NOT EXISTS backup_targets (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('local','s3')),
  path TEXT,
  endpoint TEXT,
  bucket TEXT,
  region TEXT,
  path_prefix TEXT NOT NULL DEFAULT '',
  force_path_style INTEGER NOT NULL DEFAULT 1,
  access_key_sealed TEXT,
  secret_sealed TEXT,
  write_only INTEGER NOT NULL DEFAULT 0,
  object_lock INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','failed')),
  last_checked_at INTEGER,
  last_error TEXT,
  last_test_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS backup_targets_org_name_idx
  ON backup_targets (org_id, name) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS backup_targets_platform_name_idx
  ON backup_targets (name) WHERE org_id IS NULL;
CREATE INDEX IF NOT EXISTS backup_targets_org_idx ON backup_targets (org_id, created_at);
