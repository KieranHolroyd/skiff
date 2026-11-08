-- Pipelines (docs/PIPELINES.md, WP1/WP3). Additive only.
-- A repository is an org resource (W3). An event (push, pull request, dispatch, schedule) becomes
-- a trigger; a build node resolves the workflow files at the commit; each matching workflow becomes
-- a run of jobs (a DAG) that build nodes claim by label with a renewable lease (W4).

CREATE TABLE IF NOT EXISTS pipeline_repositories (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  clone_url TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'github' CHECK (provider IN ('github','generic')),
  default_branch TEXT NOT NULL DEFAULT 'main',
  default_image TEXT,
  webhook_secret TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_number INTEGER NOT NULL DEFAULT 1,
  schedules_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_repositories_name_idx ON pipeline_repositories (org_id, name);

CREATE TABLE IF NOT EXISTS pipeline_triggers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('push','pull_request','workflow_dispatch','schedule')),
  ref TEXT NOT NULL,
  sha TEXT,
  actor TEXT,
  trust TEXT NOT NULL DEFAULT 'trusted' CHECK (trust IN ('trusted','untrusted')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','resolving','resolved','failed')),
  node_id TEXT,
  token_hash TEXT,
  lease_expires_at INTEGER,
  error TEXT,
  run_ids_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS pipeline_triggers_status_idx ON pipeline_triggers (status, created_at);
CREATE INDEX IF NOT EXISTS pipeline_triggers_repo_idx ON pipeline_triggers (repository_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_triggers_token_idx ON pipeline_triggers (token_hash);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  trigger_id TEXT,
  number INTEGER NOT NULL,
  workflow_path TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  workflow_json TEXT NOT NULL,
  event TEXT NOT NULL,
  ref TEXT NOT NULL,
  sha TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  actor TEXT,
  trust TEXT NOT NULL DEFAULT 'trusted' CHECK (trust IN ('trusted','untrusted')),
  inputs_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','in_progress','completed')),
  conclusion TEXT CHECK (conclusion IS NULL OR conclusion IN ('success','failure','cancelled','skipped','timed_out')),
  attempt INTEGER NOT NULL DEFAULT 1,
  concurrency_group TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_runs_number_idx ON pipeline_runs (repository_id, number);
CREATE INDEX IF NOT EXISTS pipeline_runs_status_idx ON pipeline_runs (status);
CREATE INDEX IF NOT EXISTS pipeline_runs_repo_created_idx ON pipeline_runs (repository_id, created_at);
CREATE INDEX IF NOT EXISTS pipeline_runs_concurrency_idx ON pipeline_runs (repository_id, concurrency_group);

CREATE TABLE IF NOT EXISTS pipeline_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  matrix_json TEXT,
  needs_json TEXT NOT NULL DEFAULT '[]',
  runs_on_json TEXT NOT NULL DEFAULT '[]',
  environment TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','waiting','queued','in_progress','completed')),
  conclusion TEXT CHECK (conclusion IS NULL OR conclusion IN ('success','failure','cancelled','skipped','timed_out')),
  node_id TEXT,
  token_hash TEXT,
  lease_expires_at INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  outputs_json TEXT NOT NULL DEFAULT '{}',
  spec_json TEXT NOT NULL,
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT,
  created_at INTEGER NOT NULL,
  queued_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS pipeline_jobs_run_idx ON pipeline_jobs (run_id);
CREATE INDEX IF NOT EXISTS pipeline_jobs_status_idx ON pipeline_jobs (status, queued_at);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_jobs_token_idx ON pipeline_jobs (token_hash);

CREATE TABLE IF NOT EXISTS pipeline_steps (
  job_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed')),
  conclusion TEXT CHECK (conclusion IS NULL OR conclusion IN ('success','failure','cancelled','skipped','timed_out')),
  outputs_json TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (job_id, idx)
);

CREATE TABLE IF NOT EXISTS pipeline_log_lines (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step INTEGER NOT NULL DEFAULT -1,
  stream TEXT NOT NULL DEFAULT 'stdout' CHECK (stream IN ('stdout','stderr','system')),
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pipeline_log_lines_job_idx ON pipeline_log_lines (job_id, seq);
CREATE INDEX IF NOT EXISTS pipeline_log_lines_ts_idx ON pipeline_log_lines (ts);

CREATE TABLE IF NOT EXISTS pipeline_artifacts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  job_id TEXT,
  name TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_artifacts_run_name_idx ON pipeline_artifacts (run_id, name);
CREATE INDEX IF NOT EXISTS pipeline_artifacts_expires_idx ON pipeline_artifacts (expires_at);

CREATE TABLE IF NOT EXISTS pipeline_caches (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  version TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready')),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_caches_key_idx ON pipeline_caches (repository_id, scope, key, version);
CREATE INDEX IF NOT EXISTS pipeline_caches_used_idx ON pipeline_caches (last_used_at);

CREATE TABLE IF NOT EXISTS pipeline_secrets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  value_sealed TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_secrets_name_idx ON pipeline_secrets (repository_id, environment, name);

CREATE TABLE IF NOT EXISTS pipeline_variables (
  repository_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repository_id, name)
);

CREATE TABLE IF NOT EXISTS pipeline_environments (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  name TEXT NOT NULL,
  allowed_refs_json TEXT NOT NULL DEFAULT '[]',
  require_approval INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_environments_name_idx ON pipeline_environments (repository_id, name);

CREATE TABLE IF NOT EXISTS pipeline_project_links (
  repository_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repository_id, project_id)
);

CREATE TABLE IF NOT EXISTS pipeline_deploys (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  object_key TEXT,
  promote INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  deployment_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pipeline_deploys_job_idx ON pipeline_deploys (job_id);
