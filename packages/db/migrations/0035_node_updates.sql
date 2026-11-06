-- Dashboard node updates (D99). Additive only.
-- An operator asks a worker to install the control plane's signed release. `update_version` is the
-- outstanding target (NULL when none); `update_generation` changes on every request so a retry is
-- a new task. Success is proven by the agent's next heartbeat reporting the target version; only a
-- failure is reported, as `update_error` for the generation in `update_failed_generation`.

ALTER TABLE nodes ADD COLUMN update_version TEXT;
ALTER TABLE nodes ADD COLUMN update_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD COLUMN update_requested_at INTEGER;
ALTER TABLE nodes ADD COLUMN update_failed_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD COLUMN update_error TEXT;
