-- Partition mounts (docs/VOLUMES.md §3.1). Additive only.
-- Settings → Storage lists every partition a node reports; "Add as volume" on an unmounted
-- ext4/xfs/btrfs/f2fs filesystem asks the node's helper to mount it by filesystem UUID at
-- /mnt/skiff-disks/<name>. Once the node's inventory shows it there it is adopted as a node volume
-- (`volume_id`) and, when `pool_id` is set, put in that pool. Nothing is ever formatted.

CREATE TABLE IF NOT EXISTS disk_mounts (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  name TEXT NOT NULL,
  fs_uuid TEXT NOT NULL,
  fs_type TEXT NOT NULL,
  device TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','mounted','failed','unmounting')),
  message TEXT,
  volume_name TEXT,
  volume_default INTEGER NOT NULL DEFAULT 0,
  pool_id TEXT,
  volume_id TEXT,
  mounted_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS disk_mounts_node_name_idx ON disk_mounts (node_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS disk_mounts_node_uuid_idx ON disk_mounts (node_id, fs_uuid);
