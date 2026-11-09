-- Yoal platform schema, migration 0001.
-- Better Auth owns user/session/organization/member/apikey; ids are unconstrained text so the
-- two migration streams stay independent (referential integrity is enforced in packages/core).

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'worker' CHECK (mode IN ('edge','worker')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','online','offline','draining')),
  public_address TEXT,
  version TEXT,
  agent_version TEXT,
  token_hash TEXT NOT NULL,
  desired_state_version INTEGER NOT NULL DEFAULT 1,
  last_heartbeat_at INTEGER,
  stats_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nodes_status_idx ON nodes (status);

CREATE TABLE IF NOT EXISTS node_join_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  node_name TEXT,
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by_node_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS node_join_tokens_hash_idx ON node_join_tokens (token_hash);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  runtime TEXT NOT NULL DEFAULT 'static' CHECK (runtime IN ('static','process','container')),
  placement TEXT NOT NULL DEFAULT 'edge',
  production_deployment_id TEXT,
  production_access TEXT NOT NULL DEFAULT 'public' CHECK (production_access IN ('public','password','platform')),
  preview_access TEXT NOT NULL DEFAULT 'platform' CHECK (preview_access IN ('public','password','platform')),
  access_secret_hash TEXT,
  site_config_json TEXT,
  created_by TEXT NOT NULL,
  deleted_at INTEGER,
  purge_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_slug_idx ON projects (slug);
CREATE INDEX IF NOT EXISTS projects_org_idx ON projects (org_id);
CREATE INDEX IF NOT EXISTS projects_deleted_idx ON projects (deleted_at);

CREATE TABLE IF NOT EXISTS slug_redirects (
  id TEXT PRIMARY KEY,
  from_slug TEXT NOT NULL,
  project_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS slug_redirects_from_idx ON slug_redirects (from_slug);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('inline','presigned')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','finalized','expired','failed')),
  object_key TEXT NOT NULL,
  storage TEXT NOT NULL CHECK (storage IN ('local','r2')),
  file_count INTEGER,
  total_bytes INTEGER,
  sha256 TEXT,
  error TEXT,
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  finalized_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_org_idx ON upload_sessions (org_id);
CREATE INDEX IF NOT EXISTS uploads_status_idx ON upload_sessions (status);

CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  object_key TEXT NOT NULL,
  storage TEXT NOT NULL CHECK (storage IN ('local','r2')),
  size_bytes INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  manifest_json TEXT NOT NULL,
  precompressed INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS releases_org_sha_idx ON releases (org_id, sha256);
CREATE INDEX IF NOT EXISTS releases_org_idx ON releases (org_id);

CREATE TABLE IF NOT EXISTS config_snapshots (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  site_config_json TEXT NOT NULL,
  env_json TEXT NOT NULL DEFAULT '{}',
  secret_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  config_snapshot_id TEXT NOT NULL,
  short_id TEXT NOT NULL,
  runtime TEXT NOT NULL DEFAULT 'static' CHECK (runtime IN ('static','process','container')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','inactive','failed','deleted')),
  preview_host TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  node_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS deployments_short_idx ON deployments (short_id);
CREATE INDEX IF NOT EXISTS deployments_project_idx ON deployments (project_id);
CREATE INDEX IF NOT EXISTS deployments_status_idx ON deployments (status);

CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  deployment_id TEXT,
  token_hash TEXT NOT NULL,
  expires_at INTEGER,
  max_visitors INTEGER,
  max_redemptions INTEGER,
  session_ttl_seconds INTEGER NOT NULL DEFAULT 3600,
  allowed_emails_json TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  redemptions INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS share_links_project_idx ON share_links (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS share_links_token_idx ON share_links (token_hash);

CREATE TABLE IF NOT EXISTS share_redemptions (
  id TEXT PRIMARY KEY,
  share_link_id TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  email TEXT,
  redeemed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS redemptions_link_idx ON share_redemptions (share_link_id);

CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','active','failed')),
  verification_token TEXT,
  verified_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS domains_host_idx ON domains (hostname);
CREATE INDEX IF NOT EXISTS domains_project_idx ON domains (project_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','apiKey','mcp','system','agent')),
  actor_id TEXT,
  client_id TEXT,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  resource_id TEXT,
  args_json TEXT,
  result TEXT NOT NULL CHECK (result IN ('ok','error')),
  error TEXT,
  ip_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_org_idx ON audit_log (org_id);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS audit_action_idx ON audit_log (action);

CREATE TABLE IF NOT EXISTS org_quotas (
  org_id TEXT PRIMARY KEY,
  projects INTEGER NOT NULL DEFAULT -1,
  storage_bytes INTEGER NOT NULL DEFAULT -1,
  retained_deployments INTEGER NOT NULL DEFAULT -1,
  max_upload_bytes INTEGER NOT NULL DEFAULT -1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS org_keys (
  org_id TEXT PRIMARY KEY,
  wrapped_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'secret' CHECK (type IN ('secret','env')),
  version INTEGER NOT NULL DEFAULT 1,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS secrets_scope_name_idx ON secrets (org_id, project_id, name, version);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backup_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('backup','restore-drill')),
  status TEXT NOT NULL CHECK (status IN ('running','ok','failed')),
  detail TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS alert_state (
  key TEXT PRIMARY KEY,
  last_fired_at INTEGER,
  last_value TEXT
);
