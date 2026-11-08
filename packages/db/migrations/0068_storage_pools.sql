-- Storage pools and placement rules (docs/STORAGE.md, D144). Additive only.
-- A pool is a platform-wide named group of node volumes (a volume is in at most one pool).
-- A rule says which pool (and overflow pool) each kind of data uses; no row keeps the legacy
-- behaviour (node default volume, else the system disk). `pool_id` NULL in a rule = the system disk.

CREATE TABLE IF NOT EXISTS storage_pools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  allocation TEXT NOT NULL DEFAULT 'most-free' CHECK (allocation IN ('most-free','fill-up')),
  min_free_percent INTEGER NOT NULL DEFAULT 10,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS storage_pools_name_idx ON storage_pools (name);

ALTER TABLE node_volumes ADD COLUMN pool_id TEXT;
CREATE INDEX IF NOT EXISTS node_volumes_pool_idx ON node_volumes (pool_id);

CREATE TABLE IF NOT EXISTS storage_rules (
  kind TEXT PRIMARY KEY,
  pool_id TEXT,
  overflow_pool_id TEXT,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
