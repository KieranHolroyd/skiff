-- Per-database PgBouncer sidecar (docs/DATABASES.md §11). Additive only.
-- Existing databases keep the pooler off until an update allocates a port; new databases get one
-- at create time and publish it on loopback only, like the Postgres port itself.

ALTER TABLE databases ADD COLUMN pooler_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE databases ADD COLUMN pooler_port INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS databases_node_pooler_port_idx
  ON databases (node_id, pooler_port) WHERE pooler_port IS NOT NULL;
