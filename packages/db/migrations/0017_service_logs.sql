-- Runtime logs for managed services (RustFS storage, Postgres). The existing `log_events` table is
-- project-scoped (project_id NOT NULL); managed services are org resources without a project, so
-- they get their own ordered table with the same cursor/retention semantics.
CREATE TABLE IF NOT EXISTS service_log_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('storage','database')),
  service_id TEXT NOT NULL,
  node_id TEXT,
  source TEXT NOT NULL DEFAULT 'runtime' CHECK (source IN ('runtime','system')),
  stream TEXT NOT NULL DEFAULT 'stdout' CHECK (stream IN ('stdout','stderr','system')),
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('debug','info','warn','error')),
  message TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS service_log_events_service_seq_idx ON service_log_events (kind, service_id, seq);
CREATE INDEX IF NOT EXISTS service_log_events_ts_idx ON service_log_events (ts);
