-- Log drains (DESIGN §8 "Logs", packages/core/src/log-drains.ts). Additive only.
-- A drain forwards an org's (or one project's) stored log lines to an external endpoint: an HTTPS
-- webhook (NDJSON or a JSON array, HMAC-signed) or an OTLP/HTTP logs receiver. The control plane
-- fans out from the tables agents already drain into, so a drain is a set of cursors over
-- `log_events.seq`, `service_log_events.seq` and `broker_log_events.seq`: a batch is shipped, then
-- the cursors move. A failure backs off; a batch that keeps failing is dropped and counted.
--
-- Auth headers and the webhook signing secret are sealed with the org key (SecretService.seal) and
-- never returned. `kind`, `format` and `min_level` carry no CHECKs on purpose (the lesson of 0028):
-- the contract validates them, so a new target is a code change, never a table rebuild.

CREATE TABLE IF NOT EXISTS log_drains (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'ndjson',
  sources_json TEXT NOT NULL DEFAULT '[]',
  min_level TEXT,
  header_names_json TEXT NOT NULL DEFAULT '[]',
  headers_sealed TEXT,
  signing_secret_sealed TEXT,
  allow_private_network INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  log_cursor INTEGER NOT NULL DEFAULT 0,
  service_cursor INTEGER NOT NULL DEFAULT 0,
  broker_cursor INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  leased_until INTEGER NOT NULL DEFAULT 0,
  delivered_lines INTEGER NOT NULL DEFAULT 0,
  delivered_batches INTEGER NOT NULL DEFAULT 0,
  dropped_lines INTEGER NOT NULL DEFAULT 0,
  dropped_batches INTEGER NOT NULL DEFAULT 0,
  last_delivered_at INTEGER,
  last_error TEXT,
  last_error_at INTEGER,
  failing_since INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS log_drains_org_idx ON log_drains (org_id);
CREATE INDEX IF NOT EXISTS log_drains_due_idx ON log_drains (enabled, next_attempt_at);
