-- Access key hash schemes (IAM.md I14, §14 S1). Additive only.
--
-- `access_keys` was created with only Skiff's `sha256(raw)` lowercase hex (0084). Spike S1 proved
-- Better Auth 1.7.15's `@better-auth/api-key` stores `base64url(sha256(raw))` without padding in
-- `apikey.key`, which is 43 characters and cannot be confused with the 64-character hex digest.
-- Because the format is not self-describing, migrated rows keep the original hash and record how
-- it was produced in this column; `AccessKeyService.verify` looks up the explicit scheme.
--
-- Existing rows are Skiff keys, so the default is `sha256`; no data rewrite is needed. New keys
-- are always `sha256`. `better-auth` rows are written only by the one-time migration, and their
-- `apikey` rows are left in place as a fallback until an operator chooses to remove them.

ALTER TABLE access_keys ADD COLUMN hash_scheme TEXT NOT NULL DEFAULT 'sha256'
  CHECK (hash_scheme IN ('sha256', 'better-auth'));
