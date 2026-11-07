-- Record where each database backup was written. Additive only.
--
-- Before this migration restore, retention and purge resolved a backup's object through whichever
-- backup target applied to the org at the time of the call (org's oldest target → platform target
-- → platform object store). Adding a target, or deleting the oldest one, silently pointed every
-- existing backup at a store that does not hold it. From now on a backup row records the target it
-- was written to and a snapshot of that target's location, and every read uses the record.
--
--   target_id      backup_targets.id; NULL means the platform object store (no target configured).
--   target_name    the target's name when the backup was taken, kept for messages after a delete.
--   location_json  {"kind":"platform"} or the target's kind/orgId/path/endpoint/bucket/region/
--                  pathPrefix when the backup was taken. Never credentials.
--
-- Backfill: existing rows get the target that resolves for their org today. That is exactly where
-- restore and retention looked for them before this migration, so nothing changes for them; the
-- difference is that it stops changing when targets do. Rows written later by a rolled-back release
-- leave location_json NULL, and the service falls back to today's resolution for those.

ALTER TABLE database_backups ADD COLUMN target_id TEXT;
ALTER TABLE database_backups ADD COLUMN target_name TEXT;
ALTER TABLE database_backups ADD COLUMN location_json TEXT;

UPDATE database_backups
SET target_id = COALESCE(
  (SELECT bt.id FROM backup_targets bt
    WHERE bt.org_id = database_backups.org_id
    ORDER BY bt.created_at ASC LIMIT 1),
  (SELECT bt.id FROM backup_targets bt
    WHERE bt.org_id IS NULL
    ORDER BY bt.created_at ASC LIMIT 1)
)
WHERE location_json IS NULL;

UPDATE database_backups
SET
  target_name = COALESCE(
    (SELECT bt.name FROM backup_targets bt WHERE bt.id = database_backups.target_id),
    'platform object store'
  ),
  location_json = COALESCE(
    (SELECT json_object(
        'kind', bt.kind,
        'orgId', bt.org_id,
        'path', bt.path,
        'endpoint', bt.endpoint,
        'bucket', bt.bucket,
        'region', bt.region,
        'pathPrefix', bt.path_prefix
      )
      FROM backup_targets bt WHERE bt.id = database_backups.target_id),
    json_object('kind', 'platform')
  )
WHERE location_json IS NULL;

CREATE INDEX IF NOT EXISTS database_backups_target_idx ON database_backups (target_id, status);
