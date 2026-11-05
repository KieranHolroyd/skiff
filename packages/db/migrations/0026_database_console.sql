-- On-demand database studio (D60). Additive only.
-- A per-database DBGate sidecar is started by the node through a fixed helper verb, publishes on
-- loopback, and is reached by the control plane through the node's internal Caddy gateway. The
-- basic-auth password is sealed with the org data key; opening/closing never restarts Postgres.
-- `console_generation` is bumped on each open/close; the node acknowledges the generation it
-- applied so a stale task cannot stop a newer session.

ALTER TABLE databases ADD COLUMN console_status TEXT NOT NULL DEFAULT 'stopped'
  CHECK (console_status IN ('stopped','starting','running','failed'));
ALTER TABLE databases ADD COLUMN console_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE databases ADD COLUMN console_port INTEGER;
ALTER TABLE databases ADD COLUMN console_secret TEXT;
ALTER TABLE databases ADD COLUMN console_read_only INTEGER NOT NULL DEFAULT 1;
ALTER TABLE databases ADD COLUMN console_expires_at INTEGER;
ALTER TABLE databases ADD COLUMN console_idle_ms INTEGER NOT NULL DEFAULT 900000;
ALTER TABLE databases ADD COLUMN console_last_used_at INTEGER;
ALTER TABLE databases ADD COLUMN console_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE databases ADD COLUMN console_applied_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE databases ADD COLUMN console_error TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS databases_node_console_port_idx
  ON databases (node_id, console_port) WHERE console_port IS NOT NULL;
