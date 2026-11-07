-- PITR recoverable window (docs/PITR.md). Additive only.
-- The node's periodic `status` task reads pgBackRest's `info` and Postgres' `pg_stat_archiver`; the
-- control plane stores the window it reports so restores are validated against the repository's
-- real contents, not a fixed retention guess. Epoch ms; NULL until the first status check.

ALTER TABLE database_pitr ADD COLUMN recoverable_from_at INTEGER;
ALTER TABLE database_pitr ADD COLUMN recoverable_to_at INTEGER;
ALTER TABLE database_pitr ADD COLUMN window_checked_at INTEGER;
