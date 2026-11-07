-- Postgres streaming read replicas (docs/CLUSTERING.md §9.2–9.3, phase C7). Additive only.
--
-- `database_replicas` gains what the replica workload needs on its node (loopback port, volume),
-- what the primary last reported about its slot, and the two-sided removal state: a row goes away
-- once the replica's node purged its data dir and the primary dropped its slot.
-- `rebuild_on_purge` re-adds a fresh replica on the same node once the old one is purged (used
-- after a promotion, when the other replicas must re-bootstrap from the new primary).

ALTER TABLE database_replicas ADD COLUMN host_port INTEGER;
ALTER TABLE database_replicas ADD COLUMN volume_id TEXT;
ALTER TABLE database_replicas ADD COLUMN mode TEXT NOT NULL DEFAULT 'async';
ALTER TABLE database_replicas ADD COLUMN message TEXT;
ALTER TABLE database_replicas ADD COLUMN sent_lsn TEXT;
ALTER TABLE database_replicas ADD COLUMN reported_at INTEGER;
ALTER TABLE database_replicas ADD COLUMN removing_at INTEGER;
ALTER TABLE database_replicas ADD COLUMN purged_at INTEGER;
ALTER TABLE database_replicas ADD COLUMN rebuild_on_purge INTEGER NOT NULL DEFAULT 0;

-- Counts promotions; replicas follow the generation they were created under.
ALTER TABLE databases ADD COLUMN primary_generation INTEGER NOT NULL DEFAULT 0;

-- One row per primary that serves (or last served) replicas: the sealed `skiff_repl` password
-- and what the primary's node last applied. Deleted once the teardown is confirmed.
CREATE TABLE IF NOT EXISTS database_replication (
  database_id TEXT PRIMARY KEY,
  secret_sealed TEXT NOT NULL,
  applied_version TEXT,
  applied_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Promotion bookkeeping on the existing failover table: the replica promoted, the state version
-- the fence was issued at, and the two leftover directories to delete afterwards.
ALTER TABLE database_failovers ADD COLUMN replica_id TEXT;
ALTER TABLE database_failovers ADD COLUMN fence_version INTEGER;
ALTER TABLE database_failovers ADD COLUMN fenced_at INTEGER;
ALTER TABLE database_failovers ADD COLUMN promoted_at INTEGER;
ALTER TABLE database_failovers ADD COLUMN old_purged_at INTEGER;
ALTER TABLE database_failovers ADD COLUMN replica_purged_at INTEGER;
ALTER TABLE database_failovers ADD COLUMN message TEXT;
CREATE INDEX IF NOT EXISTS database_failovers_status_idx ON database_failovers (status);
