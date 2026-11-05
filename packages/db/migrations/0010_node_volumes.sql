-- Node volumes (docs/VOLUMES.md, D72–D80). Additive only.
-- A volume is a mounted filesystem on one node, identified by a stable source key (filesystem
-- UUID, zfs dataset, md array, LUKS mapper, nfs/cifs export). Managed instances may be placed on
-- one instead of the helper state directory; `volume_id` is null until an operator adopts one.

CREATE TABLE IF NOT EXISTS node_volumes (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'filesystem' CHECK (kind IN ('filesystem','lvm','mdadm','zfs','luks','nfs','cifs')),
  source_key TEXT NOT NULL,
  mount_path TEXT NOT NULL,
  fs_type TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '',
  remote INTEGER NOT NULL DEFAULT 0,
  stack_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','missing','failed','removing')),
  message TEXT,
  size_bytes INTEGER,
  free_bytes INTEGER,
  stats_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS node_volumes_node_name_idx ON node_volumes (node_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS node_volumes_node_source_idx ON node_volumes (node_id, source_key);
CREATE INDEX IF NOT EXISTS node_volumes_node_idx ON node_volumes (node_id);

ALTER TABLE nodes ADD COLUMN default_volume_id TEXT;
ALTER TABLE nodes ADD COLUMN volume_inventory_json TEXT;
ALTER TABLE storage_instances ADD COLUMN volume_id TEXT;
ALTER TABLE databases ADD COLUMN volume_id TEXT;
