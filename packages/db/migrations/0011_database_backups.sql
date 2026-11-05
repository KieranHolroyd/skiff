-- Managed database backups (docs/DATABASES.md §9). Additive only.
-- The dump lives in the platform ObjectStore; this table is the index and the node reports the
-- upload result on its next heartbeat. Existing databases get a daily 03:00 UTC policy.

ALTER TABLE databases ADD COLUMN backup_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE databases ADD COLUMN backup_schedule TEXT NOT NULL DEFAULT '0 3 * * *';
ALTER TABLE databases ADD COLUMN backup_retention_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE databases ADD COLUMN next_backup_at INTEGER;
ALTER TABLE databases ADD COLUMN last_backup_at INTEGER;
ALTER TABLE databases ADD COLUMN last_backup_status TEXT;
ALTER TABLE databases ADD COLUMN last_backup_error TEXT;
ALTER TABLE databases ADD COLUMN last_verified_at INTEGER;
ALTER TABLE databases ADD COLUMN pending_restore_id TEXT;

CREATE TABLE IF NOT EXISTS database_backups (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  database_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('manual','scheduled')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','ok','failed')),
  object_key TEXT NOT NULL,
  size_bytes INTEGER,
  sha256 TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  verified_at INTEGER,
  restored_database_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS database_backups_database_idx ON database_backups (database_id, created_at);
CREATE INDEX IF NOT EXISTS database_backups_status_idx ON database_backups (status);
CREATE INDEX IF NOT EXISTS database_backups_expires_idx ON database_backups (expires_at);

-- Existing databases start on the default daily policy; give them a first run an hour after the
-- upgrade instead of waiting for the next 03:00 UTC window.
UPDATE databases
SET next_backup_at = (CAST(strftime('%s', 'now') AS INTEGER) * 1000) + 3600000
WHERE backup_enabled = 1 AND next_backup_at IS NULL;
