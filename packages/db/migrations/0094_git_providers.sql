-- GitLab, Gitea and Forgejo (docs/FORGES.md, D173–D178).
-- 1. forge_connections: one row per (org, base URL). Tokens and the webhook secret are sealed with
--    the org's data key and never returned by the API.
-- 2. forge_webhooks: the hooks Yoal created on a forge (per repository or per namespace), so a
--    hand-made webhook for a covered repository is ignored and removing a connection removes them.
-- 3. pipeline_repositories.provider and registry_oidc_trusts.provider had CHECKs listing GitHub
--    only. SQLite cannot alter a CHECK, so both tables are rebuilt with the same columns and
--    indexes and no CHECK on `provider` (the contracts enum is the source of truth); rows are
--    copied unchanged. registry_oidc_trusts gains `issuer` (GitLab CI ID tokens, D178).

CREATE TABLE IF NOT EXISTS forge_connections (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  token_sealed TEXT NOT NULL,
  clone_token_sealed TEXT,
  webhook_secret_sealed TEXT NOT NULL,
  account_login TEXT,
  clone_login TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS forge_connections_org_base_idx ON forge_connections (org_id, base_url);

CREATE TABLE IF NOT EXISTS forge_webhooks (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('repository','namespace')),
  path TEXT NOT NULL,
  hook_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS forge_webhooks_path_idx ON forge_webhooks (connection_id, scope, path);
CREATE INDEX IF NOT EXISTS forge_webhooks_org_idx ON forge_webhooks (org_id);

CREATE TABLE pipeline_repositories_new (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  clone_url TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'github',
  default_branch TEXT NOT NULL DEFAULT 'main',
  default_image TEXT,
  webhook_secret TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_number INTEGER NOT NULL DEFAULT 1,
  schedules_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  min_isolation_json TEXT NOT NULL DEFAULT '{}',
  status_token TEXT
);
INSERT INTO pipeline_repositories_new
  SELECT id, org_id, name, clone_url, provider, default_branch, default_image, webhook_secret, enabled,
         next_run_number, schedules_json, created_by, created_at, updated_at, min_isolation_json, status_token
  FROM pipeline_repositories;
DROP TABLE pipeline_repositories;
ALTER TABLE pipeline_repositories_new RENAME TO pipeline_repositories;
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_repositories_name_idx ON pipeline_repositories (org_id, name);

CREATE TABLE registry_oidc_trusts_new (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'github',
  subject_repository TEXT NOT NULL,
  subject_ref TEXT,
  repository TEXT NOT NULL,
  push INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  issuer TEXT
);
INSERT INTO registry_oidc_trusts_new
  SELECT id, org_id, provider, subject_repository, subject_ref, repository, push, created_by, created_at, NULL
  FROM registry_oidc_trusts;
DROP TABLE registry_oidc_trusts;
ALTER TABLE registry_oidc_trusts_new RENAME TO registry_oidc_trusts;
CREATE INDEX IF NOT EXISTS registry_oidc_trusts_subject_idx ON registry_oidc_trusts (provider, subject_repository);
CREATE INDEX IF NOT EXISTS registry_oidc_trusts_org_idx ON registry_oidc_trusts (org_id);
