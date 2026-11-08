-- Flows: durable, resumable multi-step work on the control plane (docs/FLOWS.md, D167).
-- A run's current position lives in `flow_runs`; every transition is appended to `flow_steps`;
-- external events (a node's backup result, a heartbeat that proves convergence) arrive as rows in
-- `flow_signals` and are consumed in the same transaction as the transition they cause.

CREATE TABLE IF NOT EXISTS flow_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  org_id TEXT,
  subject_kind TEXT,
  subject_id TEXT,
  read_permission TEXT,
  cancel_permission TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting','succeeded','failed','cancelled')),
  step TEXT NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}',
  attempt INTEGER NOT NULL DEFAULT 0,
  wake_at INTEGER,
  waiting_for TEXT,
  wait_deadline INTEGER,
  deadline_at INTEGER,
  lease_owner TEXT,
  lease_until INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  result_json TEXT,
  error TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
-- At most one active run per (kind, key); finished runs keep their key for history.
CREATE UNIQUE INDEX IF NOT EXISTS flow_runs_active_key_idx ON flow_runs (kind, key)
  WHERE status IN ('queued','running','waiting');
CREATE INDEX IF NOT EXISTS flow_runs_kind_key_idx ON flow_runs (kind, key, created_at);
CREATE INDEX IF NOT EXISTS flow_runs_due_idx ON flow_runs (status, wake_at);
CREATE INDEX IF NOT EXISTS flow_runs_subject_idx ON flow_runs (subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS flow_runs_org_idx ON flow_runs (org_id, created_at);

CREATE TABLE IF NOT EXISTS flow_steps (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  step TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  event TEXT NOT NULL,
  detail TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS flow_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS flow_signals_pending_idx ON flow_signals (run_id, name, consumed_at);
