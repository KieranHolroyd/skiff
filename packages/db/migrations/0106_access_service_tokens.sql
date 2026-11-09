-- Skiff Access machine tokens (IAM.md I25, §11.1). Additive only.
--
-- A machine token is a header pair a CI job, webhook or script presents to a host guarded by a
-- policy. New tokens live here so they can be named, listed and revoked without rewriting the
-- policy's rule JSON. The raw value is shown once at creation; only its lowercase hex SHA-256 is
-- stored, exactly like a `serviceToken` matcher in `access_policy_rules.matcher_json`.
--
-- Backward compatibility: existing `serviceToken` matchers in `access_policy_rules` keep working.
-- The edge merges both sources, with a matching deny rule still beating every allow (including a
-- token from this table). Revoking a row sets `revoked_at`; rows are kept so Settings can show the
-- machine's history and last-used time. `last_used_at` is best-effort, reported by agents at most
-- once a minute.

CREATE TABLE IF NOT EXISTS access_service_tokens (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Header name the machine sends, e.g. `X-Skiff-Access-Token`.
  header TEXT NOT NULL,
  -- Lowercase hex SHA-256 of the header value; the value itself is never stored.
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS access_service_tokens_policy_idx
  ON access_service_tokens (policy_id, revoked_at);
CREATE INDEX IF NOT EXISTS access_service_tokens_org_idx
  ON access_service_tokens (org_id, created_at);
