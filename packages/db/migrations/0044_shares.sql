-- Cluster shares (docs/CLUSTERING.md §5.2, phase C3). Additive only.
-- A share is a platform-level network filesystem definition. Credentials are an opaque reference
-- resolved at activation, never a value in this table, desired state or the audit log.

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('nfs', 'smb')),
  server TEXT NOT NULL,
  export_path TEXT NOT NULL,
  zone TEXT NOT NULL DEFAULT 'default',
  read_only INTEGER NOT NULL DEFAULT 1,
  credentials_ref TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS shares_name_idx ON shares (name);

CREATE TABLE IF NOT EXISTS share_grants (
  share_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'ro' CHECK (mode IN ('ro', 'rw')),
  path_prefix TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (share_id, org_id)
);
CREATE INDEX IF NOT EXISTS share_grants_org_idx ON share_grants (org_id);
