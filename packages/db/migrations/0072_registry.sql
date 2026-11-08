-- The platform container registry (docs/REGISTRY.md G1). Additive only.
-- Repositories are `<org slug>/<name>`, created on the first push an org member is allowed to make.
-- Tags and manifests live in the registry (zot); Skiff keeps ownership, the project link and the
-- last push it was told about. Settings and the token signing key live in `settings`.

CREATE TABLE IF NOT EXISTS registry_repositories (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  project_id TEXT,
  pushes INTEGER NOT NULL DEFAULT 0,
  last_tag TEXT,
  last_digest TEXT,
  last_push_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS registry_repositories_name_idx ON registry_repositories (name);
CREATE INDEX IF NOT EXISTS registry_repositories_org_idx ON registry_repositories (org_id);
