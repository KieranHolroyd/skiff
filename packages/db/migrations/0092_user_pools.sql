-- Managed user pools (IAM.md I26–I29, §11.2). Additive only.
--
-- A user pool is an org resource, like a database: a hosted OIDC provider for one app's end
-- users. This migration stores the pool and its OIDC clients only. The native `yoal-identity`
-- engine (I27) will own users, sessions, passwords and the hosted sign-in pages in its own
-- process and SQLite file; the control plane deliberately keeps no user rows here.
--
-- `issuer` is the pool's public OIDC issuer. It is generated from the platform's content domain
-- and the pool id, so two organisations can both call a pool "shop" without colliding. A custom
-- domain can replace it later (verified like a project domain) without changing the id.
--
-- `signing_key_id` points at the active key in the `signing_keys` ring under purpose
-- `pool:<id>` (migration 0085). The key is rotated by the existing ring; this column records the
-- key that was active when the pool last served discovery, so an operator can see which kid is
-- published.
--
-- `theme_json` is the hosted UI theme (logo, colours, copy). It is JSON with no CHECK so a theme
-- field is a contract change, never a table rebuild (the lesson of 0028). `signup_mode` is
-- `invite` or `open`; the engine reads it when hosted sign-up ships.
--
-- Clients are per pool. `client_secret_sealed` is NULL for a public client and mirrors the
-- `sso_providers`/`registry_credentials` sealing convention (organisation data key), so a secret
-- is only ever returned once, at creation. `redirect_uris_json` is the exact allowlist.

CREATE TABLE IF NOT EXISTS user_pools (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  -- A slug, unique per org (IAM.md §4).
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- The engine seam (I27). `yoal-identity` ships first; the column stays unconstrained so a
  -- later Keycloak or Authentik entry is a registry change, not a migration.
  engine TEXT NOT NULL DEFAULT 'yoal-identity',
  issuer TEXT NOT NULL,
  signing_key_id TEXT,
  -- invite | open
  signup_mode TEXT NOT NULL DEFAULT 'invite',
  theme_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- NULL = enabled. Disabling stops the engine serving this pool without losing its metadata.
  disabled_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS user_pools_org_name_idx ON user_pools (org_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS user_pools_issuer_idx ON user_pools (issuer);
CREATE INDEX IF NOT EXISTS user_pools_org_idx ON user_pools (org_id, created_at);

CREATE TABLE IF NOT EXISTS user_pool_clients (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- The public OIDC client_id. Stable for the life of the registration.
  client_id TEXT NOT NULL,
  -- NULL for a public client with PKCE; otherwise sealed with the organisation data key.
  client_secret_sealed TEXT,
  redirect_uris_json TEXT NOT NULL DEFAULT '[]',
  -- 1 = public client (no secret, PKCE required).
  public INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS user_pool_clients_pool_name_idx ON user_pool_clients (pool_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS user_pool_clients_client_id_idx ON user_pool_clients (client_id);
CREATE INDEX IF NOT EXISTS user_pool_clients_pool_idx ON user_pool_clients (pool_id);
