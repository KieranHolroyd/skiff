-- Read-only studio principal (plan 22, track G). Additive only.
-- Every managed database gets one `skiff_studio_ro` engine account that read-only studio sessions
-- connect as, so the database itself refuses their writes. Its password is sealed with the org
-- data key and reaches the node only through the node-authenticated activation fetch.
-- `studio_ro_generation` is bumped whenever the account may have been lost (restore, PITR,
-- version change); the principal is ready when `studio_ro_ready_generation` catches up.
-- `studio_ro_error` holds the last failure of the current generation (never a credential).

ALTER TABLE databases ADD COLUMN studio_ro_secret TEXT;
ALTER TABLE databases ADD COLUMN studio_ro_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE databases ADD COLUMN studio_ro_ready_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE databases ADD COLUMN studio_ro_error TEXT;
