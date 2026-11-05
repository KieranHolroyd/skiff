-- App volumes (plan 07, docs/VOLUMES.md). Additive only.
-- A project-owned volume is mounted into process/container workloads. It is backed by a node
-- volume or the helper state directory; the host path is derived on the node and never stored in
-- this table or returned by an API. Snapshots are versioned artifacts in a backup target.
-- NOTE: the migration number is reserved for the parallel Wave 1 sequence (0019–0023 land first).

CREATE TABLE IF NOT EXISTS app_volumes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  node_id TEXT NOT NULL,
  backing TEXT NOT NULL DEFAULT 'state_dir' CHECK (backing IN ('node_volume','state_dir')),
  node_volume_id TEXT,
  size_mb INTEGER NOT NULL,
  used_bytes INTEGER,
  mount_path TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','missing','failed','deleting')),
  message TEXT,
  single_writer INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  purge_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS app_volumes_project_name_idx ON app_volumes (project_id, name);
CREATE INDEX IF NOT EXISTS app_volumes_project_idx ON app_volumes (project_id);
CREATE INDEX IF NOT EXISTS app_volumes_node_idx ON app_volumes (node_id);
CREATE INDEX IF NOT EXISTS app_volumes_deleted_idx ON app_volumes (deleted_at);

CREATE TABLE IF NOT EXISTS app_volume_attachments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  volume_id TEXT NOT NULL,
  workload_id TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'production',
  mount_path TEXT NOT NULL,
  read_only INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS app_volume_attachments_volume_idx
  ON app_volume_attachments (volume_id, workload_id, environment);
CREATE UNIQUE INDEX IF NOT EXISTS app_volume_attachments_mount_idx
  ON app_volume_attachments (workload_id, environment, mount_path);
CREATE INDEX IF NOT EXISTS app_volume_attachments_project_idx ON app_volume_attachments (project_id);
CREATE INDEX IF NOT EXISTS app_volume_attachments_workload_idx ON app_volume_attachments (workload_id);

CREATE TABLE IF NOT EXISTS app_volume_snapshots (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  volume_id TEXT NOT NULL,
  target_id TEXT,
  object_key TEXT NOT NULL,
  size_bytes INTEGER,
  checksum TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','ok','failed')),
  error TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  restore_verified_at INTEGER
);
CREATE INDEX IF NOT EXISTS app_volume_snapshots_volume_idx ON app_volume_snapshots (volume_id, created_at);
CREATE INDEX IF NOT EXISTS app_volume_snapshots_status_idx ON app_volume_snapshots (status);
