-- Encrypted SAML assertions (IAM.md I19, §8.3). Additive only.
--
-- `want_assertions_encrypted` is the per-provider toggle. When it is 1 the IdP encrypts the
-- assertion to a separate SP RSA key, and the SP metadata publishes that key's certificate with
-- `use="encryption"`. The private key is sealed with the platform key in `settings` under
-- `sso.spEnc.<providerId>`; the signing key under `sso.sp.<providerId>` is never reused.
--
-- The default is 0: existing providers keep accepting plain assertions, and no encryption
-- certificate is advertised until an administrator imports it at the IdP and turns the toggle on.
-- Turning it off deletes the sealed encryption key, so a later enable starts with a fresh key and
-- a fresh certificate the IdP must import.

ALTER TABLE sso_providers ADD COLUMN want_assertions_encrypted INTEGER NOT NULL DEFAULT 0;
