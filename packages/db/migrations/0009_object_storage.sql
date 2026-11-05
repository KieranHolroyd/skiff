-- Managed object storage (docs/OBJECT-STORAGE.md, S1–S10). Additive only.
-- A storage instance is an org resource: one RustFS server run as a tier-3 container on one node.
-- Root and attachment secret keys are sealed with the org data key (D18, S6); placement and the
-- host port are resolved once at create time.

CREATE TABLE IF NOT EXISTS storage_instances (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'rustfs' CHECK (engine IN ('rustfs')),
  version TEXT NOT NULL,
  node_id TEXT NOT NULL,
  host_port INTEGER NOT NULL,
  memory_mb INTEGER NOT NULL,
  cpus REAL NOT NULL DEFAULT 1,
  storage_mb INTEGER NOT NULL DEFAULT 10240,
  public INTEGER NOT NULL DEFAULT 0,
  public_host TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','starting','running','failed','stopped')),
  message TEXT,
  root_access_key TEXT NOT NULL,
  root_secret TEXT NOT NULL,
  used_bytes INTEGER,
  objects INTEGER,
  stats_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  purge_at INTEGER,
  purge_requested_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS storage_instances_org_name_idx ON storage_instances (org_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS storage_instances_node_port_idx ON storage_instances (node_id, host_port);
CREATE UNIQUE INDEX IF NOT EXISTS storage_instances_public_host_idx ON storage_instances (public_host);
CREATE INDEX IF NOT EXISTS storage_instances_node_idx ON storage_instances (node_id);
CREATE INDEX IF NOT EXISTS storage_instances_deleted_idx ON storage_instances (deleted_at);

CREATE TABLE IF NOT EXISTS storage_buckets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  storage_id TEXT NOT NULL,
  name TEXT NOT NULL,
  access TEXT NOT NULL DEFAULT 'private' CHECK (access IN ('private','public-read')),
  size_bytes INTEGER,
  objects INTEGER,
  stats_at INTEGER,
  delete_requested_at INTEGER,
  delete_force INTEGER NOT NULL DEFAULT 0,
  delete_blocked INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS storage_buckets_name_idx ON storage_buckets (storage_id, name);

CREATE TABLE IF NOT EXISTS storage_attachments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  storage_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  env_prefix TEXT NOT NULL DEFAULT 'S3',
  grants_json TEXT NOT NULL,
  access_key_id TEXT NOT NULL,
  secret_sealed TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS storage_attachments_pair_idx ON storage_attachments (storage_id, project_id);
CREATE UNIQUE INDEX IF NOT EXISTS storage_attachments_prefix_idx ON storage_attachments (project_id, env_prefix);
CREATE UNIQUE INDEX IF NOT EXISTS storage_attachments_key_idx ON storage_attachments (access_key_id);
CREATE INDEX IF NOT EXISTS storage_attachments_project_idx ON storage_attachments (project_id);
