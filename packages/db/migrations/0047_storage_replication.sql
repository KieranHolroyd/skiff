-- Object-storage bucket replication (docs/CLUSTERING.md §10.2, phase C9). Additive only.
-- One rule links a source storage instance to a passive target. IAM, bucket config and the
-- instance row are not replicated; the control plane restores them from SQLite.

CREATE TABLE IF NOT EXISTS storage_replication (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'bucket' CHECK (mode IN ('bucket')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','linking','syncing','protected','lagging','failed','stopped')),
  last_sync_at INTEGER,
  lag_seconds REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS storage_replication_pair_idx ON storage_replication (source_id, target_id);
CREATE INDEX IF NOT EXISTS storage_replication_target_idx ON storage_replication (target_id);
