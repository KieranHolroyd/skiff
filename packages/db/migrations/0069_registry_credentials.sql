-- Registry credentials (docs/REGISTRY.md R2). Additive only.
-- An org stores a username and password/token per external registry host (ghcr.io, docker.io, …).
-- The password is sealed with the org key; it reaches a node only through the authenticated
-- activation endpoint, as the workload's auth file, never through desired state or the audit log.

CREATE TABLE IF NOT EXISTS registry_credentials (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  registry TEXT NOT NULL,
  username TEXT NOT NULL,
  password_sealed TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS registry_credentials_org_name_idx ON registry_credentials (org_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS registry_credentials_org_registry_idx ON registry_credentials (org_id, registry);
