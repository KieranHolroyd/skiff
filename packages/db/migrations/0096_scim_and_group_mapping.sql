-- SCIM 2.0 bearer tokens and SSO group mapping (IAM.md I19/I20, §8.3–§8.4). Additive only.
--
-- Numbered 0096, not the planned 0093: 0093–0095 were taken by migrations that landed before
-- this slice. The migrations runner is generated from this directory into
-- `packages/db/src/migrations.ts`, which is regenerated separately by
-- `scripts/generate-migrations.ts`.
--
-- Better Auth's `@better-auth/scim` plugin owns the SCIM resource tables (`scimUser`,
-- `scimGroup`, `scimGroupMember`, …) and creates them on boot. Yoal keeps the organisation's
-- bearer credential here so it can be minted, shown once, listed and revoked from Settings → SSO.
-- Only `sha256(token)` is stored; the raw token is never persisted or returned again.
CREATE TABLE IF NOT EXISTS scim_tokens (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
-- A token hash identifies at most one row globally, so bearer verification is a single lookup.
CREATE UNIQUE INDEX IF NOT EXISTS scim_tokens_hash_idx ON scim_tokens (token_hash);
CREATE INDEX IF NOT EXISTS scim_tokens_org_idx ON scim_tokens (org_id);

-- IdP group claim → Yoal group (IAM.md I19, §8.3). One claim value maps to one group per
-- provider. `claim_value` is stored normalised (trimmed, lowercased) so an IdP's casing changes
-- do not silently stop the mapping; memberships written from a mapping carry `source = 'sso'`.
CREATE TABLE IF NOT EXISTS sso_group_mappings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  claim_value TEXT NOT NULL,
  group_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sso_group_mappings_claim_idx
  ON sso_group_mappings (org_id, provider_id, claim_value);
CREATE INDEX IF NOT EXISTS sso_group_mappings_group_idx
  ON sso_group_mappings (group_id);
