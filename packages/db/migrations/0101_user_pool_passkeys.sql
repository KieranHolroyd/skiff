-- Passkeys for the native user-pool identity engine (IAM.md I27, §11.2). Additive only.
--
-- One row per WebAuthn credential a pool user enrolled. Credentials never leave the pool: the
-- public key is the COSE key the authenticator returned at registration, stored base64url so the
-- control plane never has to distinguish SQLite binaries from JSON. Only the public half is kept;
-- the private key never leaves the authenticator.
--
-- `credential_id` is globally unique because a credential identifies one authenticator and one
-- account. `counter` is the signature counter from the last successful assertion; a later
-- assertion whose counter does not increase is refused as a possible cloned authenticator.
-- `transports_json` is the browser's hint list (`internal`, `hybrid`, `usb`, …) used to narrow
-- `allowCredentials` once non-discoverable sign-in is offered.
--
-- The generated migrations bundle (`packages/db/src/migrations.ts`) is regenerated separately by
-- `scripts/generate-migrations.ts`; this slice does not rewrite it.

CREATE TABLE IF NOT EXISTS user_pool_passkeys (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  -- Base64url WebAuthn credential id returned by the authenticator.
  credential_id TEXT NOT NULL,
  -- Base64url COSE public key. Public material only; never a private key.
  public_key TEXT NOT NULL,
  -- Signature counter from the last accepted assertion.
  counter INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL DEFAULT 'Passkey',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS user_pool_passkeys_credential_idx
  ON user_pool_passkeys (credential_id);
CREATE INDEX IF NOT EXISTS user_pool_passkeys_user_idx
  ON user_pool_passkeys (pool_id, user_id, created_at);
