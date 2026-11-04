-- Ordered log drain for deployment runtime output and git builds (DESIGN §8).
-- `seq` is a monotonic cursor: SSE clients reconnect with the last value they saw and never
-- depend on clock resolution. Rows are pruned by age; the table is append-only while live.

CREATE TABLE IF NOT EXISTS log_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  deployment_id TEXT,
  build_id TEXT,
  node_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('runtime','build','system')),
  stream TEXT NOT NULL CHECK (stream IN ('stdout','stderr','system')),
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('debug','info','warn','error')),
  message TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS log_events_project_seq_idx ON log_events (project_id, seq);
CREATE INDEX IF NOT EXISTS log_events_deployment_seq_idx ON log_events (deployment_id, seq);
CREATE INDEX IF NOT EXISTS log_events_build_seq_idx ON log_events (build_id, seq);
CREATE INDEX IF NOT EXISTS log_events_ts_idx ON log_events (ts);
