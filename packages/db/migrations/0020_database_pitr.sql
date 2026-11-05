-- Managed database point-in-time recovery (docs/PITR.md). Additive only.
-- WAL archiving and base backups are run by pgBackRest on the database's node. This table holds
-- only the control-plane state: the stanza, a credential-free repository description, the last
-- base backup, archive health and the last restore target. Secrets never reach this table; the
-- agent fetches them from the node-authenticated activation endpoint.

CREATE TABLE IF NOT EXISTS database_pitr (
  database_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  stanza TEXT NOT NULL,
  -- Credential-free repository description (kind, endpoint, bucket, region, pathPrefix).
  repo_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','ok','failed','paused')),
  archive_status TEXT CHECK (archive_status IN ('ok','failing','unknown')),
  archive_at INTEGER,
  last_base_backup_at INTEGER,
  last_base_backup_type TEXT CHECK (last_base_backup_type IN ('full','diff','incr')),
  next_full_at INTEGER,
  next_diff_at INTEGER,
  last_restore_target_at INTEGER,
  last_restore_database_id TEXT,
  verified_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS database_pitr_status_idx ON database_pitr (status);

CREATE TABLE IF NOT EXISTS database_pitr_tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  database_id TEXT NOT NULL,
  -- `database_id` is the source for a restore; `target_database_id` is the new instance.
  target_database_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('basebackup','restore','status')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','ok','failed')),
  base_backup_type TEXT CHECK (base_backup_type IN ('full','diff','incr')),
  -- Epoch ms selected by the operator for `restore --type=time`.
  target_time INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS database_pitr_tasks_pending_idx
  ON database_pitr_tasks (status, created_at);
CREATE INDEX IF NOT EXISTS database_pitr_tasks_database_idx
  ON database_pitr_tasks (database_id, created_at);
