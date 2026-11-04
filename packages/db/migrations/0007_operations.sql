-- Mass actions and prune runs (docs/OPERATIONS.md §2). Additive only.
-- An operation is planned (a verdict per item), then applied item by item. Item status is written
-- as it runs, so a restarted control plane resumes from the first unfinished item.

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('bulk','prune')),
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','planning','planned','applying','succeeded','partial','failed','cancelled','expired')),
  stage TEXT NOT NULL DEFAULT 'plan' CHECK (stage IN ('plan','apply')),
  params_json TEXT,
  summary_json TEXT,
  phase TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  client_id TEXT,
  principal_json TEXT NOT NULL,
  idempotency_key TEXT,
  heartbeat_at INTEGER,
  plan_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS operations_org_idx ON operations (org_id, created_at);
CREATE INDEX IF NOT EXISTS operations_status_idx ON operations (status);
CREATE UNIQUE INDEX IF NOT EXISTS operations_idempotency_idx ON operations (org_id, actor_id, idempotency_key);

CREATE TABLE IF NOT EXISTS operation_items (
  operation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  category TEXT,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  label TEXT,
  verdict TEXT NOT NULL CHECK (verdict IN ('ok','skip','blocked')),
  reason TEXT,
  flags_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','skipped','failed','cancelled')),
  error TEXT,
  bytes INTEGER,
  data_json TEXT,
  updated_at INTEGER,
  PRIMARY KEY (operation_id, seq)
);
CREATE INDEX IF NOT EXISTS operation_items_status_idx ON operation_items (operation_id, status);

ALTER TABLE audit_log ADD COLUMN operation_id TEXT;
CREATE INDEX IF NOT EXISTS audit_operation_idx ON audit_log (operation_id);
