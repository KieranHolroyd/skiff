-- Social login for the native user-pool identity engine (IAM.md §11.2, I26). Additive only.
--
-- A pool can offer Google, GitHub, Microsoft and Apple sign-in. The provider row holds one OAuth
-- application's client id and a secret sealed with the organisation key (`secrets.seal`); the
-- secret is only opened while exchanging an authorization code and is never returned by a view.
-- `scopes_json` is the JSON array of extra scopes the hosted start URL asks for; an empty array
-- falls back to the provider's defaults.
--
-- An account row is the durable link between a provider identity and one pool user. It is unique
-- per (pool, provider, provider_account_id) so the same GitHub/Google account can never be attached
-- to two users in one pool, while two independent pools may still admit the same social identity.
-- `email` is the verified address the provider asserted at link time, kept for support and audit.
--
-- The generated migrations bundle (`packages/db/src/migrations.ts`) is regenerated separately by
-- `scripts/generate-migrations.ts`; this slice does not rewrite it.

CREATE TABLE IF NOT EXISTS user_pool_oauth_providers (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github', 'microsoft', 'apple')),
  -- The OAuth application's public client id.
  client_id TEXT NOT NULL,
  -- Sealed client secret (`nonce.ciphertext`), never the plain value.
  client_secret_sealed TEXT NOT NULL,
  -- JSON array of scope tokens; [] falls back to the provider's defaults.
  scopes_json TEXT NOT NULL DEFAULT '[]',
  -- 0 keeps the configuration but hides the button on the hosted sign-in page.
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS user_pool_oauth_providers_pool_provider_idx
  ON user_pool_oauth_providers (pool_id, provider);
CREATE INDEX IF NOT EXISTS user_pool_oauth_providers_pool_idx
  ON user_pool_oauth_providers (pool_id, enabled);

CREATE TABLE IF NOT EXISTS user_pool_oauth_accounts (
  pool_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github', 'microsoft', 'apple')),
  -- The provider's stable subject: Google `sub`, GitHub numeric id, Microsoft object id, Apple `sub`.
  provider_account_id TEXT NOT NULL,
  -- The verified address asserted by the provider when the account was linked.
  email TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pool_id, provider, provider_account_id)
);

CREATE INDEX IF NOT EXISTS user_pool_oauth_accounts_user_idx
  ON user_pool_oauth_accounts (pool_id, user_id);
