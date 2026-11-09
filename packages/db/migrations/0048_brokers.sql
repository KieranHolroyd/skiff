-- Managed queue brokers (docs/BROKERS.md, D111). Additive only.
-- A broker is an org resource: one message-broker server (NATS first) run as a tier-3 container
-- on one node, like a managed database. The owner password is sealed with the org data key (D18);
-- placement and the host port are resolved once at create time.
--
-- `engine` has no CHECK: the engine registry in @yoal/contracts validates it, so adding RabbitMQ
-- is a data change and never a table rebuild (the lesson of 0028).

CREATE TABLE IF NOT EXISTS brokers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'nats',
  version TEXT NOT NULL,
  node_id TEXT NOT NULL,
  host_port INTEGER NOT NULL,
  memory_mb INTEGER NOT NULL,
  cpus REAL NOT NULL DEFAULT 0.5,
  storage_mb INTEGER NOT NULL DEFAULT 2048,
  volume_id TEXT,
  restart_generation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','starting','running','failed','stopped')),
  message TEXT,
  owner_secret TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  purge_at INTEGER,
  purge_requested_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS brokers_org_name_idx ON brokers (org_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS brokers_node_port_idx ON brokers (node_id, host_port);
CREATE INDEX IF NOT EXISTS brokers_node_idx ON brokers (node_id);
CREATE INDEX IF NOT EXISTS brokers_deleted_idx ON brokers (deleted_at);

CREATE TABLE IF NOT EXISTS broker_attachments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  broker_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  env_prefix TEXT NOT NULL DEFAULT 'NATS',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS broker_attachments_pair_idx ON broker_attachments (broker_id, project_id);
CREATE UNIQUE INDEX IF NOT EXISTS broker_attachments_prefix_idx ON broker_attachments (project_id, env_prefix);
CREATE INDEX IF NOT EXISTS broker_attachments_project_idx ON broker_attachments (project_id);

-- Broker runtime logs. `service_log_events.kind` has a CHECK limited to storage/database (0017),
-- which SQLite cannot widen without a rebuild, so brokers get a table of the same shape.
CREATE TABLE IF NOT EXISTS broker_log_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  broker_id TEXT NOT NULL,
  node_id TEXT,
  source TEXT NOT NULL DEFAULT 'runtime' CHECK (source IN ('runtime','system')),
  stream TEXT NOT NULL DEFAULT 'stdout' CHECK (stream IN ('stdout','stderr','system')),
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('debug','info','warn','error')),
  message TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS broker_log_events_broker_seq_idx ON broker_log_events (broker_id, seq);
CREATE INDEX IF NOT EXISTS broker_log_events_ts_idx ON broker_log_events (ts);
