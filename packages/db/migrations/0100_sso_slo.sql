-- SAML Single Logout and IdP certificate rollover (IAM.md I19, §8.3). Additive only.
--
--   certs_json    additional IdP signing certificates beyond `cert` (a JSON array of PEM blocks).
--                 The plugin accepts one certificate or a list and accepts an assertion signed by
--                 any of them, so a rollover is: publish the new IdP certificate here, wait for the
--                 IdP to start signing with it, then remove the old one. `cert` stays the primary
--                 certificate so existing rows and readers keep their meaning.
--   slo_url       the IdP Single Logout Service URL. NULL means SLO is not configured, and the
--                 logout route only clears the local platform session.
--   slo_binding   `redirect` or `post`, matching the IdP's SingleLogoutService Binding. No CHECK
--                 on purpose (the lesson of 0028): the contract validates it.
--
-- These are read into the plugin's `samlConfig.idpMetadata.singleLogoutService` and `cert` array by
-- `sso-sync.ts`. The plugin's own SLO endpoints also need `saml.enableSingleLogout` at its
-- construction site, which is deliberately outside this migration's slice.
--
-- The generated migrations bundle (`packages/db/src/migrations.ts`) is regenerated separately by
-- `scripts/generate-migrations.ts`; this slice does not rewrite it.

ALTER TABLE sso_providers ADD COLUMN certs_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sso_providers ADD COLUMN slo_url TEXT;
ALTER TABLE sso_providers ADD COLUMN slo_binding TEXT NOT NULL DEFAULT 'redirect';
