-- Access keys in a Yoal table (IAM.md I14, §4, §7.2). Additive only.
--
-- A key is bound to one org and one principal, either a user or a service account (`sa_…`). Only
-- the SHA-256 hex of the raw `yoal_…` key is stored; `prefix` (`yoal_`) and `start` (the first eight
-- visible characters) are kept for display. The raw key is returned once, at creation, and never
-- again.
--
-- `restriction_json` carries the credential's ceiling (`{ permissions, resources }`, IAM.md §2): it
-- can only narrow the principal's bindings. `allowed_cidrs` is a JSON array of IPv4 CIDR strings;
-- an empty array means no network restriction. `expires_at` is epoch milliseconds, NULL meaning no
-- expiry (user keys default to none; service-account keys default to 90 days).
--
-- Better Auth's `apikey` rows stay authoritative until spike S1 settles whether their hashes can be
-- verified here; migrating them is still open (IAM.md §4, §14 S1). New keys are created through
-- `AccessKeyService` only.

CREATE TABLE IF NOT EXISTS access_keys (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  -- user | serviceAccount
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- `yoal_`
  prefix TEXT NOT NULL,
  -- The first eight visible characters, for the key list.
  start TEXT NOT NULL,
  -- SHA-256 of the raw key, lowercase hex.
  hash TEXT NOT NULL,
  -- { permissions: string[], resources: string[] }
  restriction_json TEXT NOT NULL DEFAULT '{}',
  -- JSON array of IPv4 CIDR strings; [] = no restriction.
  allowed_cidrs TEXT NOT NULL DEFAULT '[]',
  expires_at INTEGER,
  last_used_at INTEGER,
  -- A salted, truncated hash of the IP that last used the key (never the raw address).
  last_used_ip_hash TEXT,
  created_by TEXT NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS access_keys_hash_idx ON access_keys (hash);
CREATE INDEX IF NOT EXISTS access_keys_principal_idx ON access_keys (org_id, principal_type, principal_id);
CREATE INDEX IF NOT EXISTS access_keys_expiry_idx ON access_keys (expires_at);
