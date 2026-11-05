-- Explicit restart controls for managed object storage (docs/OBJECT-STORAGE.md §7).
-- A restart bumps restart_generation, which is folded into the activation version, so the agent
-- re-fetches activation and re-applies the unit; systemd restarts the container. Buckets, objects
-- and credentials are untouched.
ALTER TABLE storage_instances ADD COLUMN restart_generation INTEGER NOT NULL DEFAULT 0;
