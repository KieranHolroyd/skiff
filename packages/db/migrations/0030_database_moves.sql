-- Moving a managed database to another node (D97). Additive only.
-- One row per move. The database row itself is re-pointed at the target when the final dump is
-- safe in the ObjectStore; this row remembers the source placement so a failed restore can roll
-- back, and which node still holds a copy that must be purged (`purge_node_id`).
-- Phases: quiescing (attached apps stopping) -> dumping (final backup on the source) ->
-- restoring (restore on the target) -> purging (old copy being deleted) -> done; or failed.

CREATE TABLE IF NOT EXISTS database_moves (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  database_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  source_host_port INTEGER NOT NULL,
  source_pooler_port INTEGER,
  source_volume_id TEXT,
  target_volume_id TEXT,
  -- `dump`: final backup of the running database (the default). `latest-backup` and `empty` are for
  -- a database that cannot run: restore its newest good backup, or start it empty on the target.
  data_source TEXT NOT NULL DEFAULT 'dump' CHECK (data_source IN ('dump','latest-backup','empty')),
  phase TEXT NOT NULL DEFAULT 'quiescing'
    CHECK (phase IN ('quiescing','dumping','restoring','purging','done','failed')),
  outcome TEXT CHECK (outcome IN ('moved','rolled_back')),
  backup_id TEXT,
  project_ids_json TEXT NOT NULL DEFAULT '[]',
  backup_was_enabled INTEGER NOT NULL DEFAULT 0,
  quiesce_version INTEGER NOT NULL DEFAULT 0,
  purge_node_id TEXT,
  error TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS database_moves_database_idx ON database_moves (database_id, phase);
CREATE INDEX IF NOT EXISTS database_moves_phase_idx ON database_moves (phase);
