-- Jobs (plan 09, docs/SCHEDULER.md §Jobs). Additive only.
-- A job is a named command on a process/container project, optionally on a five-field UTC cron.
-- Each execution is a `job_runs` row; one-off runs have no job. The project's node leases queued
-- runs (like node tasks, D124), runs them as a transient unit with the app's sandbox and reports
-- the exit code. Output goes to `log_events` under the run's id.
--
-- `status`, `trigger` and `concurrency` keep CHECKs out on purpose (the lesson of 0028).

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  command_json TEXT NOT NULL,
  -- Five-field UTC cron; NULL is a job you only run by hand.
  schedule TEXT,
  timeout_seconds INTEGER NOT NULL,
  concurrency TEXT NOT NULL DEFAULT 'forbid',
  max_retries INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Epoch ms of the next cron fire; NULL without a schedule or while paused.
  next_run_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_project_name_idx ON jobs (project_id, name);
CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs (next_run_at);

CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  -- NULL for a one-off run.
  job_id TEXT,
  job_name TEXT,
  trigger TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  -- The first attempt's id; retries point at it.
  retry_of TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  command_json TEXT NOT NULL,
  timeout_seconds INTEGER NOT NULL,
  node_id TEXT,
  workload_id TEXT,
  deployment_id TEXT,
  exit_code INTEGER,
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  leased_until INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  -- Epoch ms it may start; later than created_at for a retry's backoff.
  run_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS job_runs_lease_idx ON job_runs (node_id, status, run_at);
CREATE INDEX IF NOT EXISTS job_runs_job_idx ON job_runs (job_id, created_at);
CREATE INDEX IF NOT EXISTS job_runs_project_idx ON job_runs (project_id, created_at);
CREATE INDEX IF NOT EXISTS job_runs_status_idx ON job_runs (status, run_at);

-- A run's output, drained by the agent like runtime logs. NULL for every other row.
ALTER TABLE log_events ADD COLUMN job_run_id TEXT;
CREATE INDEX IF NOT EXISTS log_events_job_run_seq_idx ON log_events (job_run_id, seq);
