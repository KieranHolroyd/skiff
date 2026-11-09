-- Share mounts (docs/VOLUMES.md §5, docs/CLUSTERING.md §5.2, C3). Additive only.
-- A share is mounted on a node at /mnt/yoal-shares/<share name> by the node's helper; once the
-- node reports the mount, it can be linked to Yoal as a node volume (`volume_id`).
-- SMB credentials are sealed with the platform key; they never enter desired state or the audit log.

ALTER TABLE shares ADD COLUMN credentials_sealed TEXT;
ALTER TABLE shares ADD COLUMN credentials_username TEXT;
ALTER TABLE shares ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS share_mounts (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','mounted','failed','unmounting')),
  message TEXT,
  volume_name TEXT,
  volume_default INTEGER NOT NULL DEFAULT 0,
  volume_id TEXT,
  mounted_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS share_mounts_share_node_idx ON share_mounts (share_id, node_id);
CREATE INDEX IF NOT EXISTS share_mounts_node_idx ON share_mounts (node_id);
