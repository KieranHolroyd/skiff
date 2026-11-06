-- Multi-node workload replicas (docs/CLUSTERING.md §8.2, phase C4). Additive only.
-- One row per copy. A single-node workload keeps its existing `<id>-r<n>` expansion; these rows
-- appear when copies are deliberately spread across nodes. `workload_id` is the base workload.

CREATE TABLE IF NOT EXISTS workload_replicas (
  id TEXT PRIMARY KEY,
  workload_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  replica_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','starting','running','failed','stopped')),
  placement_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS workload_replicas_index_idx ON workload_replicas (workload_id, replica_index);
CREATE INDEX IF NOT EXISTS workload_replicas_node_idx ON workload_replicas (node_id);
CREATE INDEX IF NOT EXISTS workload_replicas_project_idx ON workload_replicas (project_id);
