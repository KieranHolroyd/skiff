-- Failover controller history (docs/CLUSTERING.md §8.3, §11, phase C8). Additive only.
-- One row per action the controller decided on: a replica copy re-placed off a lost or draining
-- node, an ingress node withdrawn from or re-added to rotation, a database primary on a lost
-- node, or a change of the controller lease. `epoch` is the lease epoch the decision was made
-- under, so a write from a deposed controller is traceable. `applied_at` is when the controller
-- wrote the change (rate limits and the completion timeout count from it); `generation` is the
-- database primary generation a database failover promotes to.

CREATE TABLE IF NOT EXISTS failover_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('replica','ingress','database','lease')),
  status TEXT NOT NULL
    CHECK (status IN ('queued','in-progress','completed','failed','blocked','expired','cancelled','manual')),
  stage TEXT NOT NULL DEFAULT 'detect'
    CHECK (stage IN ('detect','decide','fence','promote','repoint','heal','complete')),
  subject_id TEXT NOT NULL,
  subject_name TEXT,
  org_id TEXT,
  from_node_id TEXT,
  to_node_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  epoch INTEGER NOT NULL DEFAULT 0,
  generation INTEGER,
  detected_at INTEGER NOT NULL,
  applied_at INTEGER,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS failover_events_status_idx ON failover_events (status, updated_at);
CREATE INDEX IF NOT EXISTS failover_events_subject_idx ON failover_events (kind, subject_id, from_node_id);
CREATE INDEX IF NOT EXISTS failover_events_detected_idx ON failover_events (detected_at);
