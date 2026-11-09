-- Per-node storage locations (D48). NULL keeps the install default; the node's root
-- yoal-storage.service moves the data and reports back through the agent heartbeat.
ALTER TABLE nodes ADD COLUMN storage_data_dir TEXT;
ALTER TABLE nodes ADD COLUMN storage_build_dir TEXT;
ALTER TABLE nodes ADD COLUMN storage_status_json TEXT;
