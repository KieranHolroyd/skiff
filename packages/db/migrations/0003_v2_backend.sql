-- v2 backend foundation: named environments, tier 2/3 workloads, git builds and custom domains.
-- Forward-only; every statement is additive so v1 rows keep working untouched.

-- Per-node workload-slice budget (D41). Edge default 1 GiB because the VPS is 4 GB in total.
ALTER TABLE nodes ADD COLUMN slice_memory_mb INTEGER NOT NULL DEFAULT 1024;
ALTER TABLE nodes ADD COLUMN slice_cpu_weight INTEGER NOT NULL DEFAULT 200;
ALTER TABLE nodes ADD COLUMN can_build INTEGER NOT NULL DEFAULT 0;

-- Runtime spec applied to new deployments of an app project.
ALTER TABLE projects ADD COLUMN workload_json TEXT;

-- Deployment snapshots and environment membership (D13, D17).
ALTER TABLE deployments ADD COLUMN environment_id TEXT;
ALTER TABLE deployments ADD COLUMN workload_json TEXT;
CREATE INDEX IF NOT EXISTS deployments_environment_idx ON deployments (environment_id);

-- Custom-domain verification state (D31).
ALTER TABLE domains ADD COLUMN kind TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('custom','apex'));
ALTER TABLE domains ADD COLUMN redirect_www INTEGER NOT NULL DEFAULT 0;
ALTER TABLE domains ADD COLUMN cloudflare_record_id TEXT;
ALTER TABLE domains ADD COLUMN last_checked_at INTEGER;
ALTER TABLE domains ADD COLUMN last_error TEXT;

CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  is_production INTEGER NOT NULL DEFAULT 0,
  access TEXT NOT NULL DEFAULT 'platform' CHECK (access IN ('public','password','platform')),
  deployment_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS environments_project_slug_idx ON environments (project_id, slug);
CREATE INDEX IF NOT EXISTS environments_project_idx ON environments (project_id);

CREATE TABLE IF NOT EXISTS workloads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  node_id TEXT,
  runtime TEXT NOT NULL CHECK (runtime IN ('process','container')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','starting','running','failed','stopped')),
  spec_json TEXT NOT NULL,
  memory_mb INTEGER NOT NULL,
  cpus INTEGER NOT NULL DEFAULT 1,
  upstream TEXT,
  message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS workloads_project_idx ON workloads (project_id);
CREATE INDEX IF NOT EXISTS workloads_node_idx ON workloads (node_id);
CREATE INDEX IF NOT EXISTS workloads_status_idx ON workloads (status);

CREATE TABLE IF NOT EXISTS git_sources (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  root_dir TEXT NOT NULL DEFAULT '.',
  build_command TEXT NOT NULL,
  output_dir TEXT NOT NULL DEFAULT 'dist',
  webhook_secret TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS git_sources_project_idx ON git_sources (project_id);

CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  git_source_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','building','succeeded','failed','cancelled')),
  ref TEXT NOT NULL,
  commit_sha TEXT,
  commit_message TEXT,
  release_id TEXT,
  deployment_id TEXT,
  node_id TEXT,
  promote INTEGER NOT NULL DEFAULT 1,
  log_tail TEXT,
  log TEXT,
  error TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS builds_project_idx ON builds (project_id);
CREATE INDEX IF NOT EXISTS builds_status_idx ON builds (status);
CREATE INDEX IF NOT EXISTS builds_created_idx ON builds (created_at);
