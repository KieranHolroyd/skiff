-- App volume snapshots, usage sampling and the trash purge (docs/VOLUMES.md §14). Additive only.
-- `used_at` is when the node last measured `used_bytes`. `purge_requested_at` marks a trashed
-- volume whose seven days are over: its node deletes the directory, then the row goes (the D59
-- pattern). `restore_snapshot_id` is set while a new volume is being filled from a snapshot.
-- Snapshots gain the label, how the copy was made (`reflink`, `paused`, `idle`, `live`), whether
-- the writer was paused, who asked for it and when the node finished. Like database backups
-- (0053) a snapshot records the target it was written to and a snapshot of that location, so a
-- later change of the default target never moves an existing snapshot.

ALTER TABLE app_volumes ADD COLUMN used_at INTEGER;
ALTER TABLE app_volumes ADD COLUMN purge_requested_at INTEGER;
ALTER TABLE app_volumes ADD COLUMN restore_snapshot_id TEXT;

ALTER TABLE app_volume_snapshots ADD COLUMN label TEXT;
ALTER TABLE app_volume_snapshots ADD COLUMN method TEXT;
ALTER TABLE app_volume_snapshots ADD COLUMN quiesce INTEGER NOT NULL DEFAULT 1;
ALTER TABLE app_volume_snapshots ADD COLUMN created_by TEXT;
ALTER TABLE app_volume_snapshots ADD COLUMN finished_at INTEGER;
ALTER TABLE app_volume_snapshots ADD COLUMN target_name TEXT;
ALTER TABLE app_volume_snapshots ADD COLUMN location_json TEXT;
