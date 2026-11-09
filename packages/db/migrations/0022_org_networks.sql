-- Per-org network isolation and named credentials (docs/build-plan/plans/04-isolation-credentials.md).
-- Additive only. Network names are derived from the org id, not stored, so no existing row changes.
-- Named credentials are sealed with the org data key; `pending_secret_sealed` holds a rotation
-- until the node confirms the role change.

CREATE TABLE IF NOT EXISTS database_credentials (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  database_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','app','monitor','readonly','backup')),
  username TEXT NOT NULL,
  secret_sealed TEXT,
  pending_secret_sealed TEXT,
  purpose TEXT,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('pending','ready','failed','revoking','revoked')),
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS database_credentials_database_idx ON database_credentials (database_id, role);
CREATE UNIQUE INDEX IF NOT EXISTS database_credentials_username_idx ON database_credentials (database_id, username);

CREATE TABLE IF NOT EXISTS storage_keys (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  storage_id TEXT NOT NULL,
  name TEXT NOT NULL,
  access_key_id TEXT NOT NULL,
  secret_sealed TEXT NOT NULL,
  grants_json TEXT NOT NULL,
  purpose TEXT,
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS storage_keys_name_idx ON storage_keys (storage_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS storage_keys_key_idx ON storage_keys (access_key_id);
CREATE INDEX IF NOT EXISTS storage_keys_storage_idx ON storage_keys (storage_id);

-- Attachments may reference a credential row. Existing rows stay NULL and keep their current
-- secrets, so an upgrade never invalidates a running app.
ALTER TABLE database_attachments ADD COLUMN credential_id TEXT;
ALTER TABLE storage_attachments ADD COLUMN credential_id TEXT;

-- Backfill the built-in owner/monitor credentials for databases created before this migration.
-- The live secrets are copied (still sealed) so reveal/list sees a credential row immediately.
INSERT INTO database_credentials (
  id, org_id, database_id, role, username, secret_sealed, purpose, status,
  created_by, created_at, updated_at
)
SELECT
  'dbc_' || lower(hex(randomblob(16))),
  d.org_id,
  d.id,
  'owner',
  replace(d.name, '-', '_'),
  d.owner_secret,
  'Database owner (built in)',
  'ready',
  d.created_by,
  d.created_at,
  d.updated_at
FROM databases d
WHERE NOT EXISTS (
  SELECT 1 FROM database_credentials c WHERE c.database_id = d.id AND c.role = 'owner'
);

INSERT INTO database_credentials (
  id, org_id, database_id, role, username, secret_sealed, purpose, status,
  created_by, created_at, updated_at
)
SELECT
  'dbc_' || lower(hex(randomblob(16))),
  d.org_id,
  d.id,
  'monitor',
  'yoal_monitor',
  d.monitor_secret,
  'Stats sampler (built in)',
  'ready',
  d.created_by,
  d.created_at,
  d.updated_at
FROM databases d
WHERE NOT EXISTS (
  SELECT 1 FROM database_credentials c WHERE c.database_id = d.id AND c.role = 'monitor'
);
