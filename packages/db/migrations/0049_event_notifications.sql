-- Event notifications (docs/EVENTS.md, D122). Additive only.
-- A rule watches one platform source (storage, alerts, deployments, database backups) and publishes
-- matching events into a queue on a managed broker, where a function consumes them. Deliveries are
-- an outbox: the broker's node agent leases pending rows, publishes them and acks. Delivered and
-- failed rows are swept after 7 days.
--
-- `source` and `status` keep CHECKs out on purpose (the lesson of 0028): the contract validates
-- them, so a new source is a code change and never a table rebuild.

CREATE TABLE IF NOT EXISTS event_rules (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  source TEXT NOT NULL,
  events_json TEXT NOT NULL DEFAULT '[]',
  filter_json TEXT NOT NULL DEFAULT '{}',
  broker_id TEXT NOT NULL,
  queue TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS event_rules_org_source_idx ON event_rules (org_id, source);
CREATE INDEX IF NOT EXISTS event_rules_broker_idx ON event_rules (broker_id);

CREATE TABLE IF NOT EXISTS event_deliveries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  broker_id TEXT NOT NULL,
  queue TEXT NOT NULL,
  event_type TEXT NOT NULL,
  body_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  leased_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS event_deliveries_lease_idx ON event_deliveries (broker_id, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS event_deliveries_rule_idx ON event_deliveries (rule_id, created_at);
CREATE INDEX IF NOT EXISTS event_deliveries_sweep_idx ON event_deliveries (status, created_at);
