-- Org authentication policy (IAM.md I21, §4, §8.5). Additive only.
--
-- One row per organisation. Every column is optional behaviour: a missing row means the defaults
-- in `packages/core/src/iam/auth-policy.ts` (no SSO requirement, no 2FA requirement, every sign-in
-- method, no session limits, no IP allowlist, no break-glass owners).
--
-- Units: `session_max_age` and `idle_timeout` are seconds. NULL (or 0) means "no limit".
-- `break_glass_user_ids_json` lists owner user ids who keep passkey/TOTP/password sign-in when
-- `require_sso` is on; every one is re-checked to still be an owner when the policy is saved.
CREATE TABLE IF NOT EXISTS org_auth_policies (
  org_id TEXT PRIMARY KEY,
  require_sso INTEGER NOT NULL DEFAULT 0,
  require_2fa INTEGER NOT NULL DEFAULT 0,
  allowed_methods_json TEXT NOT NULL DEFAULT '["password","passkey","github","magic-link","sso"]',
  session_max_age INTEGER,
  idle_timeout INTEGER,
  ip_allowlist_json TEXT NOT NULL DEFAULT '[]',
  break_glass_user_ids_json TEXT NOT NULL DEFAULT '[]'
);
