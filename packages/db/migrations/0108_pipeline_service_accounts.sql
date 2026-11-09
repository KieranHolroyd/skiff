-- Per-repository pipeline service accounts (IAM.md I3, §7.2). Additive only.
--
-- A trusted pipeline runs its control-plane side (deploying a linked project, updating a workload
-- image) as the repository's own service account, not as the person who triggered the run. The
-- account is `pipeline-<repo>`, generated on repository creation (and lazily on the first run for
-- repositories that predate this migration). This column links the two; NULL means the account has
-- not been provisioned yet, and the first run backfills it.
--
-- The runner still receives the existing signed `pjt_` job token. The service account is what the
-- engine uses for `deployment:create` / `project:update` after `pipeline_project_links` has allowed
-- the target, so removing the creator from the org no longer stops the repository's automation.

ALTER TABLE pipeline_repositories ADD COLUMN service_account_id TEXT;

CREATE INDEX IF NOT EXISTS pipeline_repositories_service_account_idx
  ON pipeline_repositories (service_account_id);
