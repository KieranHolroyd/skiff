-- User-pool attachments (IAM.md I28, §11.2). Additive only.
--
-- A pool attaches to a project like a database or broker. The attachment row carries no secret:
-- it points at an existing confidential `user_pool_clients` row whose `client_secret_sealed` is
-- opened only at activation, under the prefix the attachment chose. `env_prefix` is unique per
-- project, matching `database_attachments` and `broker_attachments`, so `<P>_ISSUER`,
-- `<P>_CLIENT_ID` and `<P>_CLIENT_SECRET` can never collide with another service's names.
--
-- `client_row_id` is `user_pool_clients.id`, not the public OIDC `client_id`, so a client can be
-- re-registered without rewriting attachments. A pool or client with attachments cannot be
-- deleted until they are detached (the same rule databases and brokers follow).

CREATE TABLE IF NOT EXISTS user_pool_attachments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  client_row_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  env_prefix TEXT NOT NULL DEFAULT 'AUTH',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS user_pool_attachments_pair_idx
  ON user_pool_attachments (pool_id, project_id);
CREATE UNIQUE INDEX IF NOT EXISTS user_pool_attachments_prefix_idx
  ON user_pool_attachments (project_id, env_prefix);
CREATE INDEX IF NOT EXISTS user_pool_attachments_project_idx
  ON user_pool_attachments (project_id);
CREATE INDEX IF NOT EXISTS user_pool_attachments_client_idx
  ON user_pool_attachments (client_row_id);
