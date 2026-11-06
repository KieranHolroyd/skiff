-- Moving a storage instance to another node (D97). Additive only.
-- Objects cannot be copied between nodes yet, so a move starts the instance empty on the target
-- (buckets, keys and attachments are desired state and come back). `purge_node_id` names the node
-- whose old copy still has to be deleted; it is cleared once that node reports the purge.

ALTER TABLE storage_instances ADD COLUMN purge_node_id TEXT;
CREATE INDEX IF NOT EXISTS storage_instances_purge_node_idx ON storage_instances (purge_node_id);
