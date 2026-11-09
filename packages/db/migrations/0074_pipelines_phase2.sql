-- Pipelines, remaining phases (docs/PIPELINES.md WP2–WP6).
-- 1. `yoal_event` triggers: pipeline_triggers.event had a CHECK listing four events. SQLite cannot
--    alter a CHECK, so the table is rebuilt with the same columns and indexes and no CHECK on
--    `event` (the contracts enum is the source of truth). Rows are copied unchanged.
-- 2. Repository isolation minimums (W14) and a write-only commit-status token.
-- 3. Step summaries ($YOAL_STEP_SUMMARY).
-- 4. The OCI runtime a job was claimed with (W14).

CREATE TABLE pipeline_triggers_new (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  event TEXT NOT NULL,
  ref TEXT NOT NULL,
  sha TEXT,
  actor TEXT,
  trust TEXT NOT NULL DEFAULT 'trusted' CHECK (trust IN ('trusted','untrusted')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','resolving','resolved','failed')),
  node_id TEXT,
  token_hash TEXT,
  lease_expires_at INTEGER,
  error TEXT,
  run_ids_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
INSERT INTO pipeline_triggers_new
  SELECT id, org_id, repository_id, event, ref, sha, actor, trust, payload_json, status, node_id, token_hash,
         lease_expires_at, error, run_ids_json, created_by, created_at, finished_at
  FROM pipeline_triggers;
DROP TABLE pipeline_triggers;
ALTER TABLE pipeline_triggers_new RENAME TO pipeline_triggers;
CREATE INDEX IF NOT EXISTS pipeline_triggers_status_idx ON pipeline_triggers (status, created_at);
CREATE INDEX IF NOT EXISTS pipeline_triggers_repo_idx ON pipeline_triggers (repository_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_triggers_token_idx ON pipeline_triggers (token_hash);

ALTER TABLE pipeline_repositories ADD COLUMN min_isolation_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE pipeline_repositories ADD COLUMN status_token TEXT;

ALTER TABLE pipeline_steps ADD COLUMN summary TEXT;

ALTER TABLE pipeline_jobs ADD COLUMN runtime TEXT;
