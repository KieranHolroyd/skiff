-- One-time codes for the CLI browser login (`yoal login --web`).
-- The CLI holds the PKCE verifier; only the code hash is stored.

CREATE TABLE IF NOT EXISTS cli_login_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cli_login_codes_expires_idx ON cli_login_codes (expires_at);
