-- Promotion history: when a deployment last became production (ms since epoch).
-- Rollback targets the most recently promoted deployment before the current one, so it never
-- lands on a preview that was never live. Forward-only.

ALTER TABLE deployments ADD COLUMN promoted_at INTEGER;

-- Backfill from the audit log: promotes, rollbacks and deploys created with promote=true.
UPDATE deployments SET promoted_at = (
  SELECT MAX(a.created_at) FROM audit_log a
  WHERE a.resource = 'deployment' AND a.resource_id = deployments.id AND a.result = 'ok'
    AND (a.action IN ('deployment.promote', 'deployment.rollback')
         OR (a.action = 'deployment.create' AND json_extract(a.args_json, '$.promote') = 1))
);

-- Whatever is production now has been promoted, even if its audit rows are gone.
UPDATE deployments SET promoted_at = created_at
  WHERE promoted_at IS NULL
    AND id IN (SELECT production_deployment_id FROM projects WHERE production_deployment_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS deployments_promoted_idx ON deployments (project_id, promoted_at);
