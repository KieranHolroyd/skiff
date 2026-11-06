-- Managed database replicas (docs/CLUSTERING.md §9.2, phase C7). Additive only.
-- One row per replica; the primary remains the `databases` row. LSN/lag are last-reported values.
-- `primary_generation` fences a promotion over a stale primary.

CREATE TABLE IF NOT EXISTS database_replicas (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','streaming','lagging','lost','failed','stopped')),
  replay_lsn TEXT,
  lag_bytes INTEGER,
  lag_seconds REAL,
  slot TEXT,
  primary_generation INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS database_replicas_pair_idx ON database_replicas (database_id, node_id);
CREATE INDEX IF NOT EXISTS database_replicas_node_idx ON database_replicas (node_id);

CREATE TABLE IF NOT EXISTS database_failovers (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL,
  from_node_id TEXT,
  to_node_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','promoting','completed','failed','rolled-back')),
  reason TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS database_failovers_database_idx ON database_failovers (database_id, started_at);
