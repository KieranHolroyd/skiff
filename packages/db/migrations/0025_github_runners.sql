-- GitHub Actions runner registrations (plan 21, docs/RUNNERS.md). Additive only.
-- One row per ephemeral runner the control plane registered with GitHub through a JIT config.
-- The row lets the control plane remove a replica's previous registration when it mints the next
-- one, and lets project deletion deregister what is left. No credential is stored here.

CREATE TABLE IF NOT EXISTS github_runner_registrations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workload_id TEXT NOT NULL,
  replica INTEGER NOT NULL,
  runner_id INTEGER NOT NULL,
  runner_name TEXT NOT NULL,
  target TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS github_runner_registrations_workload_idx
  ON github_runner_registrations (workload_id, replica);
CREATE INDEX IF NOT EXISTS github_runner_registrations_project_idx
  ON github_runner_registrations (project_id);
