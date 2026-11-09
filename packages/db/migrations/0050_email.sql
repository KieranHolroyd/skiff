-- Email: Yoal's self-hosted SES (docs/EMAIL.md, D114–D120). Additive only.
-- Platform settings (the mail node, the global pause, the mail-state generation) live in the
-- `settings` key/value table under `email.*` keys, so only tenant data gets tables here.

-- Per-org sending state and limits (EMAIL.md §7.3). A row is created on first use; orgs start in
-- the sandbox except the platform owner's first org.
CREATE TABLE IF NOT EXISTS email_orgs (
  org_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'sandbox' CHECK (state IN ('sandbox','active','paused')),
  per_second INTEGER NOT NULL DEFAULT 1,
  per_day INTEGER NOT NULL DEFAULT 200,
  paused_reason TEXT,
  updated_at INTEGER NOT NULL
);

-- Sending/receiving identities (EMAIL.md §4.1, D116). The DKIM private key is sealed with the org
-- data key (D18). A name is unique across the platform: one org per domain.
CREATE TABLE IF NOT EXISTS email_domains (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sending INTEGER NOT NULL DEFAULT 1,
  receiving INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','failed')),
  dkim_selector TEXT NOT NULL,
  dkim_public TEXT NOT NULL,
  dkim_private_sealed TEXT NOT NULL,
  -- Last check result (EmailRecordCheck[] as JSON) and the Cloudflare record ids Yoal manages.
  records_json TEXT NOT NULL DEFAULT '[]',
  managed_json TEXT NOT NULL DEFAULT '{}',
  last_checked_at INTEGER,
  verified_at INTEGER,
  failing_since INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS email_domains_name_idx ON email_domains (name);
CREATE INDEX IF NOT EXISTS email_domains_org_idx ON email_domains (org_id);

-- Verified single addresses: sandbox recipients and forward targets (EMAIL.md §4.3).
CREATE TABLE IF NOT EXISTS email_addresses (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  address TEXT NOT NULL,
  token_hash TEXT,
  verified_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS email_addresses_org_address_idx ON email_addresses (org_id, address);

-- SMTP/API credentials (EMAIL.md §5.4). `hash` authenticates; `secret_sealed` is injected into an
-- attached project's env. `env_prefix` is set only for project attachments.
CREATE TABLE IF NOT EXISTS email_credentials (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT,
  name TEXT NOT NULL,
  username TEXT NOT NULL,
  hash TEXT NOT NULL,
  secret_sealed TEXT NOT NULL,
  allowed_from_json TEXT NOT NULL DEFAULT '[]',
  env_prefix TEXT,
  last_used_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS email_credentials_username_idx ON email_credentials (username);
CREATE INDEX IF NOT EXISTS email_credentials_org_idx ON email_credentials (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS email_credentials_attachment_idx ON email_credentials (project_id, env_prefix) WHERE env_prefix IS NOT NULL AND revoked_at IS NULL;

-- REST and binding sends waiting for the mail node's agent (D117). Deleted once spooled.
CREATE TABLE IF NOT EXISTS email_outbox (
  message_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER
);
CREATE INDEX IF NOT EXISTS email_outbox_created_idx ON email_outbox (created_at);

-- The message log (EMAIL.md §8.1, D120): one row per message, one per recipient, kept 30 days.
CREATE TABLE IF NOT EXISTS email_messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('api','smtp','binding')),
  from_address TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'accepted',
  idempotency_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_messages_org_created_idx ON email_messages (org_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS email_messages_idempotency_idx ON email_messages (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_recipients (
  message_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  org_id TEXT NOT NULL,
  address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted',
  bounce_class TEXT,
  last_response TEXT,
  hard_bounced INTEGER NOT NULL DEFAULT 0,
  complained INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, idx)
);
CREATE INDEX IF NOT EXISTS email_recipients_org_created_idx ON email_recipients (org_id, created_at);
CREATE INDEX IF NOT EXISTS email_recipients_address_idx ON email_recipients (org_id, address);

-- Suppression lists (EMAIL.md §7.1, D119). `org_id = '*'` is the platform-wide list.
CREATE TABLE IF NOT EXISTS email_suppressions (
  org_id TEXT NOT NULL,
  address TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('bounce','complaint','manual','unsubscribe')),
  message_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (org_id, address)
);
