-- Registry deployment pins and deploy-on-push (docs/REGISTRY.md R11, §5.3). Additive only.
-- A pin is a hidden `skiff-d-<deployment id>` tag on the digest a deployment runs, so retention
-- never deletes an image a deployment (or its rollback) needs. A row lives until the pin tag is
-- removed from the registry after its deployment row is gone.

CREATE TABLE IF NOT EXISTS registry_pins (
  deployment_id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS registry_pins_repository_idx ON registry_pins (repository);

-- Deploy on push: a push of `deploy_tag` to the repository deploys it to the project.
ALTER TABLE registry_repositories ADD COLUMN deploy_project_id TEXT;
ALTER TABLE registry_repositories ADD COLUMN deploy_tag TEXT;
