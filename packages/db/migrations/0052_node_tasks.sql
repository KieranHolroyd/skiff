-- Node tasks (D124). Additive only.
-- One-shot reads and test actions that only the node running a service can do: peek, purge or
-- delete a broker stream, send a test message, redrive a dead-letter queue, send a test request to
-- a function or run one of its crons now. The control plane inserts a row; the target node's agent
-- leases it, runs the fixed verb for its kind and posts the result. Rows are short-lived: finished
-- ones are swept after an hour, because a result can hold message bodies.
--
-- `kind` and `status` keep CHECKs out on purpose (the lesson of 0028).

CREATE TABLE IF NOT EXISTS node_tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_type TEXT NOT NULL,
  -- Broker id, or the desired-state id of the function host the agent dials.
  target_id TEXT NOT NULL,
  target_name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result_json TEXT,
  error TEXT,
  leased_until INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS node_tasks_lease_idx ON node_tasks (node_id, status, created_at);
CREATE INDEX IF NOT EXISTS node_tasks_org_idx ON node_tasks (org_id, status);
CREATE INDEX IF NOT EXISTS node_tasks_sweep_idx ON node_tasks (status, created_at);
