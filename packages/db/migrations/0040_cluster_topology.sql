-- Cluster topology (docs/CLUSTERING.md §3, phase C0). Additive only.
-- A node reports hardware facts in its heartbeat; the operator assigns the failure domain and the
-- roles it may run. Placement filters on those facts once, at deploy time. NULL roles_json keeps
-- the old derivation from mode/can_build; the default zone keeps every existing install behaving
-- exactly as before. Volume classes are derived and displayed in C0; enforcement follows.

ALTER TABLE nodes ADD COLUMN zone TEXT NOT NULL DEFAULT 'default';
ALTER TABLE nodes ADD COLUMN roles_json TEXT;
ALTER TABLE nodes ADD COLUMN labels_json TEXT;
ALTER TABLE nodes ADD COLUMN hardware_json TEXT;
ALTER TABLE nodes ADD COLUMN hardware_at INTEGER;
ALTER TABLE nodes ADD COLUMN hardware_error TEXT;
ALTER TABLE nodes ADD COLUMN lan_endpoint TEXT;
ALTER TABLE nodes ADD COLUMN cpu_budget_millis INTEGER;

ALTER TABLE node_volumes ADD COLUMN class TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE node_volumes ADD COLUMN class_override TEXT;
ALTER TABLE node_volumes ADD COLUMN class_override_reason TEXT;

ALTER TABLE projects ADD COLUMN placement_json TEXT;

CREATE INDEX IF NOT EXISTS nodes_zone_idx ON nodes (zone);
