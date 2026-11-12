-- App errors are a top-level service (docs/APP-ERRORS.md): targets can be linked to a Yoal
-- project automatically, or created standalone for an off-platform app. Existing rows backfill
-- from their project; the synthetic `project_id` of a standalone target keeps every issue, event,
-- key and usage row in the same tables.
ALTER TABLE app_error_projects ADD COLUMN org_id TEXT;
ALTER TABLE app_error_projects ADD COLUMN name TEXT;
ALTER TABLE app_error_projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'project';
ALTER TABLE app_error_projects ADD COLUMN auto_linked INTEGER NOT NULL DEFAULT 0;

UPDATE app_error_projects
SET org_id = (SELECT org_id FROM projects WHERE projects.id = app_error_projects.project_id)
WHERE org_id IS NULL;
UPDATE app_error_projects
SET name = (SELECT name FROM projects WHERE projects.id = app_error_projects.project_id)
WHERE name IS NULL;
UPDATE app_error_projects SET name = project_id WHERE name IS NULL;
CREATE INDEX IF NOT EXISTS app_error_projects_org_idx ON app_error_projects (org_id, kind);

-- One row per organisation: when auto_link is on, every current and future project gets a target
-- and a DSN injected into its workloads. Turning it off disables only targets still marked
-- auto_linked; a target enabled by hand stays on.
CREATE TABLE IF NOT EXISTS app_error_settings (
  org_id TEXT PRIMARY KEY,
  auto_link INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
