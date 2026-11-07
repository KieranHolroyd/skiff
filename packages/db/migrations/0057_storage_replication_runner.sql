-- Object-storage replication runner and staged root-key rotation (docs/OBJECT-STORAGE.md §5, §12).
-- Additive only.
--
-- storage_replication: each rule gets its own scoped key on the peer instance (sealed with the org
-- key, like attachment keys), plus the last progress the node's replicator reported. NULL key
-- columns on rules created before this migration are filled in by the control plane on first use.
--
-- storage_instances: a pending root key pair. While it is set the instance is activated with it;
-- the node confirms the new key works and the control plane promotes it, or rolls back.

ALTER TABLE storage_replication ADD COLUMN access_key_id TEXT;
ALTER TABLE storage_replication ADD COLUMN secret_sealed TEXT;
ALTER TABLE storage_replication ADD COLUMN last_error TEXT;
ALTER TABLE storage_replication ADD COLUMN last_attempt_at INTEGER;
ALTER TABLE storage_replication ADD COLUMN initial_sync_at INTEGER;
ALTER TABLE storage_replication ADD COLUMN pending_objects INTEGER;
ALTER TABLE storage_replication ADD COLUMN objects_copied INTEGER NOT NULL DEFAULT 0;
ALTER TABLE storage_replication ADD COLUMN bytes_copied INTEGER NOT NULL DEFAULT 0;
ALTER TABLE storage_replication ADD COLUMN buckets_json TEXT;

ALTER TABLE storage_instances ADD COLUMN root_pending_access_key TEXT;
ALTER TABLE storage_instances ADD COLUMN root_pending_secret TEXT;
ALTER TABLE storage_instances ADD COLUMN root_rotation_started_at INTEGER;
ALTER TABLE storage_instances ADD COLUMN root_rotation_error TEXT;
ALTER TABLE storage_instances ADD COLUMN root_rotated_at INTEGER;
