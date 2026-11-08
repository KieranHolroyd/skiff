-- Disks and default storage (docs/STORAGE.md, D169). Additive only.
-- Node volumes become "disks": the table keeps its 0010 name (`node_volumes`) and gains a tier
-- (`fast`/`bulk`, derived from the hardware until an operator sets it) and `mount_uuid` for a
-- filesystem Skiff mounts by UUID at /mnt/skiff-disks/<name> (folds in `disk_mounts`, 0078).
-- Defaults are per kind of service: `system`, `fast` or `bulk`. `storage_pools`, `storage_rules`,
-- `disk_mounts` and `nodes.default_volume_id` are no longer read.

ALTER TABLE node_volumes ADD COLUMN tier TEXT NOT NULL DEFAULT 'bulk' CHECK (tier IN ('fast','bulk'));
ALTER TABLE node_volumes ADD COLUMN tier_set INTEGER NOT NULL DEFAULT 0;
ALTER TABLE node_volumes ADD COLUMN mount_uuid TEXT;

UPDATE node_volumes SET tier = 'fast' WHERE COALESCE(class_override, class) = 'fast';
UPDATE node_volumes SET tier_set = 1 WHERE class_override IS NOT NULL;
UPDATE node_volumes
  SET mount_uuid = (SELECT disk_mounts.fs_uuid FROM disk_mounts WHERE disk_mounts.volume_id = node_volumes.id)
  WHERE mount_uuid IS NULL AND EXISTS (SELECT 1 FROM disk_mounts WHERE disk_mounts.volume_id = node_volumes.id);

CREATE TABLE IF NOT EXISTS storage_defaults (
  kind TEXT PRIMARY KEY,
  target TEXT NOT NULL CHECK (target IN ('system','fast','bulk')),
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A saved pool default becomes the tier most of that pool's disks had; `system` stays `system`.
INSERT OR IGNORE INTO storage_defaults (kind, target, updated_by, updated_at)
  SELECT r.kind,
    CASE
      WHEN r.pool_id IS NULL THEN 'system'
      WHEN (SELECT COUNT(*) FROM node_volumes v WHERE v.pool_id = r.pool_id AND v.tier = 'fast')
         > (SELECT COUNT(*) FROM node_volumes v WHERE v.pool_id = r.pool_id AND v.tier = 'bulk') THEN 'fast'
      WHEN EXISTS (SELECT 1 FROM node_volumes v WHERE v.pool_id = r.pool_id) THEN 'bulk'
      ELSE 'system'
    END,
    r.updated_by, r.updated_at
  FROM storage_rules r;
