-- SAML 2.0 providers for @better-auth/sso (IAM.md I19, §8.3). Additive only.
--
-- `sso_providers.protocol` already reserves `saml` (0087) and deliberately has no CHECK, so this
-- migration only adds the columns the plugin's `samlConfig` needs. The OIDC columns keep their
-- meaning and are left empty for a SAML row:
--
--   issuer                  the IdP entity id (manual entry, or imported from IdP metadata)
--   client_id                '' (SAML has no OAuth client)
--   client_secret_sealed     '' (no client secret; the IdP's private key never reaches Yoal)
--   discovery_url            the IdP metadata URL, when one was imported
--   authorization/token/jwks NULL
--   scopes_json              unused by SAML; the 0087 default stays for the row shape
--
-- `entry_point` is the IdP SSO URL. `cert` is the IdP's public signing certificate, stored in the
-- clear: it is public material, and only the IdP holds the matching private key. `callback_url`
-- records the ACS URL advertised to the IdP (derived from the provider id, so it is stable even
-- before the row exists). `sp_entity_id` is the SP entity id used in SP metadata; it defaults to
-- the SP metadata URL. `audience` and `identifier_format` are optional overrides, and
-- `want_assertions_signed` is 1 unless an administrator turns signed-assertion enforcement off.
--
-- The generated migrations bundle (`packages/db/src/migrations.ts`) is regenerated separately by
-- `scripts/generate-migrations.ts`; this slice does not rewrite it.

ALTER TABLE sso_providers ADD COLUMN entry_point TEXT;
ALTER TABLE sso_providers ADD COLUMN cert TEXT;
ALTER TABLE sso_providers ADD COLUMN callback_url TEXT;
ALTER TABLE sso_providers ADD COLUMN sp_entity_id TEXT;
ALTER TABLE sso_providers ADD COLUMN audience TEXT;
ALTER TABLE sso_providers ADD COLUMN want_assertions_signed INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sso_providers ADD COLUMN identifier_format TEXT;
