-- Public database connection URL (D60 follow-up). Additive only.
-- Skiff keeps Postgres loopback-only (D56); an operator may expose it through a TCP proxy or
-- tunnel and store the public connection string here. The URL is sealed with the org data key and
-- is only decrypted by an audited reveal, never by list/get, desired state or MCP.

ALTER TABLE databases ADD COLUMN public_url_sealed TEXT;
ALTER TABLE databases ADD COLUMN public_url_updated_at INTEGER;
ALTER TABLE databases ADD COLUMN public_url_updated_by TEXT;
