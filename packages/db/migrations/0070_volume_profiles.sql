-- Storage profiles (docs/STORAGE.md §5). Additive only.
-- One row per benchmark of one node volume: queued by the control plane, run by the node's helper
-- (fio, else dd), reported in the heartbeat. Rows are history; the latest per volume is shown.

CREATE TABLE IF NOT EXISTS volume_profiles (
  id TEXT PRIMARY KEY,
  volume_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  method TEXT,
  size_mb INTEGER NOT NULL,
  runtime_seconds INTEGER NOT NULL,
  seq_read_mbps REAL,
  seq_write_mbps REAL,
  rand_read_iops INTEGER,
  rand_write_iops INTEGER,
  sync_write_iops INTEGER,
  sync_write_latency_us INTEGER,
  direct INTEGER,
  notes_json TEXT,
  error TEXT,
  requested_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS volume_profiles_volume_idx ON volume_profiles (volume_id, created_at);
CREATE INDEX IF NOT EXISTS volume_profiles_node_status_idx ON volume_profiles (node_id, status);
