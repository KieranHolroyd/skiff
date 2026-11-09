-- Native user-pool identity engine (IAM.md I10, I26–I28, §11.2). Additive only.
--
-- 0092 stored each pool and its OIDC clients. This migration adds the native engine's own rows:
-- end users, sessions, one-time OIDC authorization codes, email-verification tokens and invites.
-- The control plane hosts these rows for the email/password slice; passwords use `Bun.password`
-- (argon2id), never Better Auth's `user`/`session`/`account` tables, so a pool is fully isolated
-- from platform sign-in. A future `yoal-identity` process owns the same shape in its own SQLite
-- file per pool (I27); the seaming is in `packages/core/src/user-pool-engine.ts`.
--
-- Tokens are never stored raw: `user_pool_sessions.id`, `user_pool_codes.code_hash`,
-- `user_pool_invites.token_hash` and `user_pool_email_tokens.token_hash` are SHA-256 hex digests.
-- A session and an authorization code are returned once, to the caller that created them.

CREATE TABLE IF NOT EXISTS user_pool_users (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  -- Normalised lowercase. Unique per pool, not globally: two pools may both have ada@example.com.
  email TEXT NOT NULL,
  -- NULL until the address is proved. Invitation sign-ups are proved by the invite token.
  email_verified_at INTEGER,
  -- `Bun.password` argon2id encoded hash, including its salt and parameters.
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  -- Public/private user metadata for custom claims later; JSON with no CHECK (lesson of 0028).
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- NULL = enabled. Disabling blocks sign-in and revokes existing sessions.
  disabled_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS user_pool_users_pool_email_idx ON user_pool_users (pool_id, email);
CREATE INDEX IF NOT EXISTS user_pool_users_pool_idx ON user_pool_users (pool_id, created_at);

CREATE TABLE IF NOT EXISTS user_pool_sessions (
  -- SHA-256 hex of the opaque session token handed to the browser cookie.
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  -- Written at most once a minute, the idle-timeout clock for a later slice.
  last_seen_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS user_pool_sessions_user_idx ON user_pool_sessions (pool_id, user_id, expires_at);
CREATE INDEX IF NOT EXISTS user_pool_sessions_expiry_idx ON user_pool_sessions (expires_at);

CREATE TABLE IF NOT EXISTS user_pool_codes (
  -- SHA-256 hex of the authorization code. The raw code exists only in the redirect.
  code_hash TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  -- OIDC nonce, echoed into the id_token when the client sent one.
  nonce TEXT,
  -- PKCE S256 challenge and method. A public client always has one.
  code_challenge TEXT,
  code_challenge_method TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS user_pool_codes_pool_idx ON user_pool_codes (pool_id, expires_at);
CREATE INDEX IF NOT EXISTS user_pool_codes_user_idx ON user_pool_codes (user_id);

-- Invite-only sign-up. An admin mints an invite for an address; the raw token is returned once and
-- stored only as a hash. A valid pending invite proves the address, so its user starts verified.
CREATE TABLE IF NOT EXISTS user_pool_invites (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS user_pool_invites_token_idx ON user_pool_invites (token_hash);
CREATE INDEX IF NOT EXISTS user_pool_invites_email_idx ON user_pool_invites (pool_id, email, used_at);

-- Single-use email links (verification today; password reset and magic links can reuse the shape).
CREATE TABLE IF NOT EXISTS user_pool_email_tokens (
  token_hash TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  -- verify_email
  purpose TEXT NOT NULL DEFAULT 'verify_email',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX IF NOT EXISTS user_pool_email_tokens_user_idx ON user_pool_email_tokens (pool_id, user_id, purpose);
