-- App errors (docs/APP-ERRORS.md): the app-facing error tracker. Additive only.
--
-- Every project can enable one tracker. `dsn_project_id` is the numeric id in the public Sentry
-- DSN (`https://<key>@<host>/ingest/<dsn_project_id>`); Yoal's own project id stays `prj_…` and is
-- never exposed in a DSN because the Sentry SDKs require a numeric project id.
--
-- `app_error_keys` holds the public 32-hex key(s) a client may send with. A key is public by
-- design: it can only append events to one project. Rotation revokes the old key after a grace
-- period.
--
-- Issues group by `(project_id, fingerprint)`. Counts are exact; stored events are sampled and
-- capped per issue. `environment` is part of the fingerprint, so staging does not reopen or
-- inflate a production issue. Release is not, so a bug survives deploys.
--
-- `app_error_usage` is one row per project per month (`YYYY-MM`) for the soft cap shown in settings.
-- Stored events and hourly counts are pruned after 30 days; quiet issues after 90 days.
CREATE TABLE IF NOT EXISTS app_error_projects (
  dsn_project_id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 0,
  sample_rate REAL NOT NULL DEFAULT 1,
  notify INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_error_keys (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT 'default',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS app_error_keys_project_idx ON app_error_keys (project_id, revoked_at);

CREATE TABLE IF NOT EXISTS app_error_issues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  platform TEXT NOT NULL,
  environment TEXT NOT NULL,
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  culprit TEXT,
  level TEXT NOT NULL DEFAULT 'error',
  status TEXT NOT NULL DEFAULT 'unresolved',
  event_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  first_release TEXT,
  last_release TEXT,
  regressed_at INTEGER,
  resolved_at INTEGER,
  resolved_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS app_error_issues_fingerprint_idx ON app_error_issues (project_id, fingerprint);
CREATE INDEX IF NOT EXISTS app_error_issues_status_idx ON app_error_issues (project_id, status, last_seen_at);

CREATE TABLE IF NOT EXISTS app_error_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  exceptions_json TEXT NOT NULL DEFAULT '[]',
  method TEXT,
  path TEXT,
  release TEXT,
  environment TEXT,
  tags_json TEXT NOT NULL DEFAULT '{}',
  contexts_json TEXT NOT NULL DEFAULT '{}',
  extra_json TEXT,
  user_id TEXT,
  platform TEXT,
  sdk TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS app_error_events_event_idx ON app_error_events (project_id, event_id);
CREATE INDEX IF NOT EXISTS app_error_events_issue_idx ON app_error_events (issue_id, at);
CREATE INDEX IF NOT EXISTS app_error_events_at_idx ON app_error_events (at);

CREATE TABLE IF NOT EXISTS app_error_hourly (
  issue_id TEXT NOT NULL,
  hour INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (issue_id, hour)
);
CREATE INDEX IF NOT EXISTS app_error_hourly_hour_idx ON app_error_hourly (hour);

CREATE TABLE IF NOT EXISTS app_error_usage (
  project_id TEXT NOT NULL,
  month TEXT NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 0,
  dropped INTEGER NOT NULL DEFAULT 0,
  ignored INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, month)
);
