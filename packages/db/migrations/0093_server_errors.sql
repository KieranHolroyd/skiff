-- Server errors (docs/SERVER-ERRORS.md, D171). Additive only.
--
-- A built-in, very small error tracker for the control plane itself: unexpected exceptions in
-- dashboard loads and actions, REST handlers that fell through to a 500, 5xx responses, and
-- background loops (maintenance, failover, jobs, flows, drains). Events with the same fingerprint
-- (source + error name + normalised message + top stack frames) group into one issue.
--
-- `server_error_issues.status` is `unresolved`, `resolved` or `ignored`. A new event on a resolved
-- issue reopens it (`regressed_at` is set); an ignored issue keeps counting but stays quiet.
-- Messages and stacks are scrubbed of credentials before they are stored, paths never keep their
-- query string, and no request body or header is ever kept.
--
-- Stored events are sampled (at most one per issue per second, and a global per-minute budget) and
-- capped per issue, so exact counts live in `event_count` and in `server_error_hourly`, one row per
-- issue per hour (`hour` is epoch milliseconds floored to the hour).
--
-- Retention: each issue keeps its newest 50 events; events and hourly counts older than 30 days
-- and issues not seen for 90 days are pruned by the maintenance sweep.
CREATE TABLE IF NOT EXISTS server_error_issues (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('request','api','response','background')),
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  culprit TEXT,
  status TEXT NOT NULL DEFAULT 'unresolved' CHECK (status IN ('unresolved','resolved','ignored')),
  event_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  first_version TEXT,
  last_version TEXT,
  regressed_at INTEGER,
  resolved_at INTEGER,
  resolved_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS server_error_issues_fingerprint_idx ON server_error_issues (fingerprint);
CREATE INDEX IF NOT EXISTS server_error_issues_status_idx ON server_error_issues (status, last_seen_at);

CREATE TABLE IF NOT EXISTS server_error_events (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  method TEXT,
  path TEXT,
  route_id TEXT,
  status INTEGER,
  user_id TEXT,
  org_id TEXT,
  version TEXT,
  context_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS server_error_events_issue_idx ON server_error_events (issue_id, at);
CREATE INDEX IF NOT EXISTS server_error_events_at_idx ON server_error_events (at);

CREATE TABLE IF NOT EXISTS server_error_hourly (
  issue_id TEXT NOT NULL,
  hour INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (issue_id, hour)
);
CREATE INDEX IF NOT EXISTS server_error_hourly_hour_idx ON server_error_hourly (hour);
