-- Connected apps (Settings → Connected apps). Additive only.
-- When an MCP/OAuth client last called Yoal for a user. Better Auth owns the grant itself
-- (`oauthConsent`, `oauthRefreshToken`): this table only records use, written by `/mcp` at most
-- once a minute per pair, and is cleared when the grant is revoked. A missing row means the client
-- has not called since this table was added; the list then falls back to its last token refresh.

CREATE TABLE IF NOT EXISTS oauth_client_usage (
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, client_id)
);
