-- Bucket configuration and share links (docs/OBJECT-STORAGE.md, plan 02b). Additive only.
-- The control plane stores the desired state; the node's agent converges it over the RustFS S3 and
-- admin APIs and reports the applied config_version back. Object lock is create-only and cannot be
-- undone. Share links store only a hash of the browser token, never a key or a signature.

ALTER TABLE storage_buckets ADD COLUMN versioning INTEGER NOT NULL DEFAULT 0;
ALTER TABLE storage_buckets ADD COLUMN lifecycle_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE storage_buckets ADD COLUMN cors_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE storage_buckets ADD COLUMN quota_bytes INTEGER;
ALTER TABLE storage_buckets ADD COLUMN object_lock_json TEXT;
ALTER TABLE storage_buckets ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE storage_buckets ADD COLUMN config_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (config_status IN ('pending','converged','error','unsupported'));
ALTER TABLE storage_buckets ADD COLUMN config_message TEXT;
ALTER TABLE storage_buckets ADD COLUMN last_converged_at INTEGER;

CREATE TABLE IF NOT EXISTS storage_share_links (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  storage_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET' CHECK (method IN ('GET','PUT')),
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  max_downloads INTEGER,
  downloads INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS storage_share_links_token_idx ON storage_share_links (token_hash);
CREATE INDEX IF NOT EXISTS storage_share_links_storage_idx ON storage_share_links (storage_id);
