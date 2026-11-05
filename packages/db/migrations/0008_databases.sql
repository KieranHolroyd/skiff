-- Managed databases (docs/DATABASES.md, D55–D61). Additive only.
-- A database is an org resource run as a tier-3 container on one node. Credentials are sealed with
-- the org data key (D18, D58); placement and the host port are resolved once at create time.

CREATE TABLE IF NOT EXISTS databases (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'postgres' CHECK (engine IN ('postgres')),
  version TEXT NOT NULL,
  node_id TEXT NOT NULL,
  host_port INTEGER NOT NULL,
  memory_mb INTEGER NOT NULL,
  cpus REAL NOT NULL DEFAULT 1,
  storage_mb INTEGER NOT NULL DEFAULT 10240,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','starting','running','failed','stopped')),
  message TEXT,
  owner_secret TEXT NOT NULL,
  monitor_secret TEXT NOT NULL,
  size_bytes INTEGER,
  stats_json TEXT,
  stats_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  purge_at INTEGER,
  purge_requested_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS databases_org_name_idx ON databases (org_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS databases_node_port_idx ON databases (node_id, host_port);
CREATE INDEX IF NOT EXISTS databases_node_idx ON databases (node_id);
CREATE INDEX IF NOT EXISTS databases_deleted_idx ON databases (deleted_at);

CREATE TABLE IF NOT EXISTS database_attachments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  database_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  env_prefix TEXT NOT NULL DEFAULT 'DATABASE',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS database_attachments_pair_idx ON database_attachments (database_id, project_id);
CREATE UNIQUE INDEX IF NOT EXISTS database_attachments_prefix_idx ON database_attachments (project_id, env_prefix);
CREATE INDEX IF NOT EXISTS database_attachments_project_idx ON database_attachments (project_id);
