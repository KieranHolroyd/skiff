-- Remove the DBGate studio's per-database session state (D96 supersedes D60).
-- The native studio keeps its sessions in `database_studio_sessions` (0029); nothing reads the
-- `console_*` columns any more. Reviewed destructive change: the release that ships this
-- migration no longer references these columns, and a rollback to a release that does needs
-- the pre-update snapshot (docs/OPS.md §4.2.2), not `--keep-db`.
-- SQLite (>= 3.35) drops a column in place when nothing else in the schema refers to it, so the
-- partial unique index on `console_port` goes first. `console_status` carries only its own
-- column CHECK, which is dropped with it.

DROP INDEX IF EXISTS databases_node_console_port_idx;

ALTER TABLE databases DROP COLUMN console_status;
ALTER TABLE databases DROP COLUMN console_requested;
ALTER TABLE databases DROP COLUMN console_port;
ALTER TABLE databases DROP COLUMN console_secret;
ALTER TABLE databases DROP COLUMN console_read_only;
ALTER TABLE databases DROP COLUMN console_expires_at;
ALTER TABLE databases DROP COLUMN console_idle_ms;
ALTER TABLE databases DROP COLUMN console_last_used_at;
ALTER TABLE databases DROP COLUMN console_generation;
ALTER TABLE databases DROP COLUMN console_applied_generation;
ALTER TABLE databases DROP COLUMN console_error;
