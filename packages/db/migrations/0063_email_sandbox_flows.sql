-- Email sandbox flows (docs/EMAIL.md §4.3, §7.3). Additive only.
--
-- Sandbox recipients: `email_addresses` (0050) already holds the address, the hashed single-use
-- token and `verified_at`. These columns pace the verification mail: when the last link went out
-- (the link expires a day later) and how many went out for the current token.
ALTER TABLE email_addresses ADD COLUMN sent_at INTEGER;
ALTER TABLE email_addresses ADD COLUMN send_count INTEGER NOT NULL DEFAULT 0;

-- Production access requests: an org owner asks to leave the sandbox, a platform admin approves
-- (the org becomes active with the limits the admin picks) or denies. One pending request per org.
-- `status` keeps CHECKs out on purpose (the lesson of 0028).
CREATE TABLE IF NOT EXISTS email_access_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  use_case TEXT NOT NULL,
  expected_daily_volume INTEGER NOT NULL,
  website TEXT,
  requested_by TEXT NOT NULL,
  -- Copied at request time so the decision can still be mailed if the user row changes.
  requester_email TEXT,
  decided_by TEXT,
  decided_at INTEGER,
  decision_note TEXT,
  granted_per_day INTEGER,
  granted_per_second INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_access_requests_org_idx ON email_access_requests (org_id, created_at);
CREATE INDEX IF NOT EXISTS email_access_requests_status_idx ON email_access_requests (status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS email_access_requests_pending_idx ON email_access_requests (org_id) WHERE status = 'pending';
