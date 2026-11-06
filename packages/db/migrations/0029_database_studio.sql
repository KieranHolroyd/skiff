-- Native database studio sessions (plan 22, D96). Additive only.
-- One row per user session. The session token is sealed with the org data key and reaches the
-- node only through the node-authenticated activation fetch, never desired state. Closed rows are
-- kept for history; `close_reason` says why (closed, mode-change, expired, idle, deleted).
-- The DBGate `console_*` columns on `databases` stay until the plan 22 Phase 3 cutover.

CREATE TABLE IF NOT EXISTS database_studio_sessions (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  token_sealed TEXT NOT NULL,
  read_only INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER NOT NULL,
  idle_ms INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  close_reason TEXT
);
CREATE INDEX IF NOT EXISTS database_studio_sessions_user_idx
  ON database_studio_sessions (database_id, user_id);
CREATE INDEX IF NOT EXISTS database_studio_sessions_node_idx
  ON database_studio_sessions (node_id);
