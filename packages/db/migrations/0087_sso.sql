-- SSO with OIDC: per-organisation providers and verified email domains (IAM.md I19, §4, §8.3).
-- Additive only.
--
-- Better Auth's SSO plugin (`@better-auth/sso`, spike S2) is not a dependency yet, so it has not
-- created its boot-migrated `ssoProvider` table. Until it is added, Skiff keeps the provider in
-- `sso_providers`; the columns mirror that plugin's model (issuer, client id/secret, OIDC config,
-- organisation id, domain) so adopting the plugin is a copy, not a rewrite. The client secret is
-- sealed with the organisation data key (`SecretService.seal`); the raw value is never returned.
--
-- `sso_domains` is exactly IAM.md §4. A TXT record `skiff-verify=<token>` on the domain proves
-- ownership. A domain is globally unique: two organisations can never route the same address, and
-- `/login` can resolve an email to exactly one provider. `last_checked_at` is the day-long
-- re-check the settings page performs; `verified_at` is the current state, cleared when the record
-- disappears so an unverified domain stops routing.

CREATE TABLE IF NOT EXISTS sso_providers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- oidc today; saml arrives with the plugin and needs no table rebuild (no CHECK, lesson of 0028).
  protocol TEXT NOT NULL DEFAULT 'oidc',
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  -- `nonce.ciphertext`, sealed with the organisation key.
  client_secret_sealed TEXT NOT NULL,
  -- The discovery document endpoint, when the issuer does not serve the standard one.
  discovery_url TEXT,
  -- Endpoints copied from discovery at save time. NULL until the document has been fetched.
  authorization_endpoint TEXT,
  token_endpoint TEXT,
  jwks_endpoint TEXT,
  scopes_json TEXT NOT NULL DEFAULT '["openid","profile","email"]',
  -- Claim mapping: which claim carries the email, display name and IdP groups.
  claim_email TEXT NOT NULL DEFAULT 'email',
  claim_name TEXT NOT NULL DEFAULT 'name',
  claim_groups TEXT NOT NULL DEFAULT 'groups',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sso_providers_org_issuer_idx ON sso_providers (org_id, issuer);
CREATE INDEX IF NOT EXISTS sso_providers_org_idx ON sso_providers (org_id);

CREATE TABLE IF NOT EXISTS sso_domains (
  org_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  txt_token TEXT NOT NULL,
  verified_at INTEGER,
  last_checked_at INTEGER
);
-- One owner per domain, so email routing is unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS sso_domains_domain_idx ON sso_domains (domain);
CREATE INDEX IF NOT EXISTS sso_domains_org_idx ON sso_domains (org_id);
CREATE INDEX IF NOT EXISTS sso_domains_check_idx ON sso_domains (last_checked_at);
