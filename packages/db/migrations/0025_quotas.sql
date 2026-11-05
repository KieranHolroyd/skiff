-- Quotas, usage and showback (docs/QUOTAS.md, plan 16). Additive only.
-- Extended org quotas are nullable with a -1 default: null and -1 both mean unlimited, so existing
-- orgs keep their current behaviour after the upgrade. `storage_bytes` already exists and is not
-- repeated here. Per-project overrides are nullable = inherit the org quota.

ALTER TABLE org_quotas ADD COLUMN databases INTEGER DEFAULT -1;
ALTER TABLE org_quotas ADD COLUMN database_storage_bytes INTEGER DEFAULT -1;
ALTER TABLE org_quotas ADD COLUMN storage_instances INTEGER DEFAULT -1;
ALTER TABLE org_quotas ADD COLUMN storage_objects INTEGER DEFAULT -1;
ALTER TABLE org_quotas ADD COLUMN app_volumes INTEGER DEFAULT -1;
ALTER TABLE org_quotas ADD COLUMN app_volume_bytes INTEGER DEFAULT -1;
ALTER TABLE org_quotas ADD COLUMN jobs INTEGER DEFAULT -1;
ALTER TABLE org_quotas ADD COLUMN job_runs_per_day INTEGER DEFAULT -1;
ALTER TABLE org_quotas ADD COLUMN builds_per_day INTEGER DEFAULT -1;
ALTER TABLE org_quotas ADD COLUMN previews INTEGER DEFAULT -1;
ALTER TABLE org_quotas ADD COLUMN workload_memory_mb INTEGER DEFAULT -1;
ALTER TABLE org_quotas ADD COLUMN egress_bytes INTEGER DEFAULT -1;

CREATE TABLE IF NOT EXISTS project_quotas (
  project_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  projects INTEGER,
  storage_bytes INTEGER,
  retained_deployments INTEGER,
  max_upload_bytes INTEGER,
  databases INTEGER,
  database_storage_bytes INTEGER,
  storage_instances INTEGER,
  storage_objects INTEGER,
  app_volumes INTEGER,
  app_volume_bytes INTEGER,
  jobs INTEGER,
  job_runs_per_day INTEGER,
  builds_per_day INTEGER,
  previews INTEGER,
  workload_memory_mb INTEGER,
  egress_bytes INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS project_quotas_org_idx ON project_quotas (org_id);

-- One row per org/project and UTC day. `project_id` is an empty string for the org roll-up so the
-- composite key is stable in SQLite, where NULLs compare as distinct.
CREATE TABLE IF NOT EXISTS usage_snapshots (
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, project_id, day)
);
CREATE INDEX IF NOT EXISTS usage_snapshots_org_day_idx ON usage_snapshots (org_id, day);
