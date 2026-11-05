-- Generic durable scheduler (docs/SCHEDULER.md, F4). Additive only.
-- One row per unit of deferred work. `kind + key` is the idempotency key; a lease makes a crashed
-- worker's task reclaimable once `lease_until` passes. Timestamps are epoch milliseconds, like the
-- rest of the platform schema.

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  run_at INTEGER NOT NULL,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','leased','ok','failed','cancelled')),
  result_json TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_tasks_kind_key_idx ON scheduled_tasks (kind, key);
CREATE INDEX IF NOT EXISTS scheduled_tasks_due_idx ON scheduled_tasks (status, run_at);
CREATE INDEX IF NOT EXISTS scheduled_tasks_lease_idx ON scheduled_tasks (status, lease_until);
